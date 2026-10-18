// Types of typst-core.mjs (plain JavaScript, so a worker thread runs it as it is).

export declare const FONT_FILES: readonly string[]
export declare const DOCUMENT_TEMPLATE: string

export interface CoreAssets {
  readonly wasm: Uint8Array
  readonly fonts: readonly Uint8Array[]
  readonly template: string
}

export declare function loadCoreAssets(): CoreAssets

export interface CoreRenderRequest {
  readonly template?: string
  readonly data: string
  readonly images?: readonly { readonly path: string; readonly bytes: Uint8Array }[]
}

export interface Core {
  readonly defaultTemplate: string
  render(request: CoreRenderRequest): Promise<Uint8Array>
  /** Decodes one image (measured, never printed); rejects when the compiler cannot decode it. */
  probe(image: { readonly path: string; readonly bytes: Uint8Array }): Promise<void>
}

export declare function createCore(assets?: CoreAssets): Promise<Core>
