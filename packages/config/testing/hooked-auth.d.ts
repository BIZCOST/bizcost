export interface HookedAuth {
  readonly url: string
  stop(): Promise<void>
}
export declare function startHookedAuth(overrides?: Record<string, string>): Promise<HookedAuth>
