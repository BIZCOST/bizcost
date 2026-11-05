import { describe, expect, it } from 'vitest'
import { missingFromTrace, REQUIRED_FILES } from './check-pdf-trace.mjs'

describe('the PDF engine in the API function trace (D-353)', () => {
  it('names what a trace leaves out', () => {
    expect(missingFromTrace(REQUIRED_FILES)).toEqual([])
    const withoutCompiler = REQUIRED_FILES.filter((file) => !file.includes('@myriaddreamin'))
    expect(missingFromTrace(withoutCompiler)).toEqual(
      REQUIRED_FILES.filter((file) => file.includes('@myriaddreamin')),
    )
  })

  it('asks for the compiler, its WebAssembly, the worker, the template and the four fonts', () => {
    expect(REQUIRED_FILES.some((file) => file.endsWith('.wasm'))).toBe(true)
    expect(REQUIRED_FILES.some((file) => file.endsWith('worker.mjs'))).toBe(true)
    expect(REQUIRED_FILES.some((file) => file.endsWith('document.typ'))).toBe(true)
    expect(REQUIRED_FILES.filter((file) => file.endsWith('.ttf'))).toHaveLength(4)
  })
})
