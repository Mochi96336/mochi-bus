import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))

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

const legacyHighCardRepository = 'infrastructure/transit/snapshot-repository.ts'
const highCardReadPattern = /\b(?:FROM|JOIN)\s+(?:stops|pattern_stops)\b/i
const highCardMutationPattern = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:stops|pattern_stops)\b/i

function productionSourceFiles(directory) {
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

function isLegacyRepositorySpecifier(value) {
  return /(?:^|\/)snapshot-repository$/.test(value)
}

function sourcePath(file) {
  return relative(srcRoot, file).replaceAll('\\', '/')
}

function sourceFileFor(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function stringLikeText(node, sourceFile) {
  if (ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateExpression(node)) {
    return node.getText(sourceFile)
  }
  return null
}

describe('snapshot high-cardinality D1 architecture boundary', () => {
  it('keeps legacy high-cardinality exports reachable only from their R2-first wrappers', () => {
    const wrapperImports = []
    const bypasses = []

    for (const file of productionSourceFiles(srcRoot)) {
      const path = sourcePath(file)
      const source = readFileSync(file, 'utf8')
      const sourceFile = sourceFileFor(file, source)

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

      const visit = (node) => {
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

  it('keeps high-cardinality D1 SQL read-only and confined to the legacy repository', () => {
    const readFiles = new Set()
    const mutations = []

    for (const file of productionSourceFiles(srcRoot)) {
      const path = sourcePath(file)
      const source = readFileSync(file, 'utf8')
      const sourceFile = sourceFileFor(file, source)

      const visit = (node) => {
        const text = stringLikeText(node, sourceFile)
        if (text) {
          if (highCardReadPattern.test(text)) readFiles.add(path)
          if (highCardMutationPattern.test(text)) mutations.push(path)
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }

    expect([...readFiles].sort()).toEqual([legacyHighCardRepository])
    expect(mutations).toEqual([])
  })
})
