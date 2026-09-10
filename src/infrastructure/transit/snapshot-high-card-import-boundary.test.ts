import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const srcRoot = fileURLToPath(new URL('../../../src/', import.meta.url))

const legacyHighCardExports = new Set([
  'getSnapshotRouteVariants',
  'searchStopPlaces',
  'getStopPlaceByStopUid',
  'getStopPlaceRoutes',
  'getDirectRoutes',
  'getOneTransferRoutes',
  'getJourneyLegStopRefs',
])

const expectedWrapperImports = [
  'infrastructure/transit/snapshot-pattern-stop-repository.ts:getJourneyLegStopRefs',
  'infrastructure/transit/snapshot-pattern-stop-repository.ts:getSnapshotRouteVariants',
  'infrastructure/transit/snapshot-place-routing-repository.ts:getDirectRoutes',
  'infrastructure/transit/snapshot-place-routing-repository.ts:getStopPlaceRoutes',
  'infrastructure/transit/snapshot-stop-lookup-repository.ts:getStopPlaceByStopUid',
  'infrastructure/transit/snapshot-stop-lookup-repository.ts:searchStopPlaces',
  'infrastructure/transit/snapshot-transfer-routing-repository.ts:getOneTransferRoutes',
].sort()

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return productionSourceFiles(path)
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return []
      if (/\.(?:test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return []
      return [path]
    })
    .sort()
}

function isLegacyRepositorySpecifier(value: string): boolean {
  return /(?:^|\/)snapshot-repository$/.test(value)
}

function sourcePath(file: string): string {
  return relative(srcRoot, file).replaceAll('\\', '/')
}

describe('snapshot high-cardinality D1 import boundary', () => {
  it('keeps legacy high-cardinality exports reachable only from their R2-first wrappers', () => {
    const wrapperImports: string[] = []
    const bypasses: string[] = []

    for (const file of productionSourceFiles(srcRoot)) {
      const path = sourcePath(file)
      const source = readFileSync(file, 'utf8')
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )

      for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)
          && ts.isStringLiteral(statement.moduleSpecifier)
          && isLegacyRepositorySpecifier(statement.moduleSpecifier.text)) {
          const bindings = statement.importClause?.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) {
            bypasses.push(`${path}: namespace import from snapshot-repository`)
            continue
          }
          if (!bindings || !ts.isNamedImports(bindings)) continue

          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text
            if (legacyHighCardExports.has(imported)) {
              wrapperImports.push(`${path}:${imported}`)
            }
          }
        }

        if (ts.isExportDeclaration(statement)
          && statement.moduleSpecifier
          && ts.isStringLiteral(statement.moduleSpecifier)
          && isLegacyRepositorySpecifier(statement.moduleSpecifier.text)) {
          if (!statement.exportClause) {
            bypasses.push(`${path}: export * from snapshot-repository`)
            continue
          }
          if (!ts.isNamedExports(statement.exportClause)) continue
          for (const element of statement.exportClause.elements) {
            const exported = element.propertyName?.text ?? element.name.text
            if (legacyHighCardExports.has(exported)) {
              bypasses.push(`${path}: re-exports legacy ${exported}`)
            }
          }
        }
      }

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.arguments.length === 1) {
          const [argument] = node.arguments
          if (ts.isStringLiteral(argument) && isLegacyRepositorySpecifier(argument.text)) {
            const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
            const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
            if (dynamicImport || requireCall) {
              bypasses.push(`${path}: dynamic snapshot-repository import`)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }

    expect(bypasses).toEqual([])
    expect(wrapperImports.sort()).toEqual(expectedWrapperImports)
  })
})
