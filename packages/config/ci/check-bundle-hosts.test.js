import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSupabaseHosts, scan } from './check-bundle-hosts.js'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake build folder: { 'static/chunks/a.js': '…' }. */
function build(files) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-hosts-'))
  dirs.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('findSupabaseHosts', () => {
  it('finds project hosts and the bare domain, in any case', () => {
    const hosts = findSupabaseHosts(
      'fetch("https://abcdefghijklmnopqrst.supabase.co/auth/v1");x="//SUPABASE.CO/";',
    )
    expect(hosts.map((h) => h.host)).toEqual(['abcdefghijklmnopqrst.supabase.co', 'supabase.co'])
  })

  it('ignores supabase.com and other longer names', () => {
    expect(findSupabaseHosts('https://realtime.supabase.com/worker.js supabase.co-op')).toEqual([])
  })

  it('reports the wildcard pattern as its own host', () => {
    expect(findSupabaseHosts('t.push("*.supabase.co","*.supabase.in")')).toEqual([
      { host: '*.supabase.co', index: 8 },
    ])
  })
})

describe('scan', () => {
  it('passes a Next build without Supabase hosts, and finds the expected text', () => {
    const root = build({
      'static/chunks/app.js': 'const u="https://auth.example.invalid";t.push("*.supabase.co")',
      'server/app/login.html': '<html>ok</html>',
    })
    expect(scan([root], ['auth.example.invalid'])).toEqual({ fileCount: 2, problems: [] })
  })

  it('fails on a project host in browser code and in prerendered pages', () => {
    const root = build({
      'static/chunks/app.js': 'createClient("https://abcdefghijklmnopqrst.supabase.co")',
      'server/app/index.rsc': '1:["https://x.supabase.co/storage/v1/object/sign/a"]',
      'server/pages/404.html': '<img src="https://y.supabase.co/a.png">',
    })
    const { problems } = scan([root])
    expect(problems.map((p) => p.message.split(':')[0])).toEqual([
      'contains abcdefghijklmnopqrst.supabase.co',
      'contains x.supabase.co',
      'contains y.supabase.co',
    ])
  })

  it("skips the server's own code, manifests and source maps", () => {
    const root = build({
      'static/chunks/app.js': 'ok',
      'static/chunks/app.js.map': '{"sourcesContent":["// https://xyz.supabase.co"]}',
      'server/app/page.js': 'const url = "https://abcdefghijklmnopqrst.supabase.co"',
      'server/app/page_client-reference-manifest.json': '{"a":"https://x.supabase.co"}',
    })
    expect(scan([root]).problems).toEqual([])
  })

  it('scans any other folder whole (e.g. an Expo export)', () => {
    const root = build({ '_expo/static/js/web/entry.js': '"https://abc.supabase.co"' })
    expect(scan([root]).problems).toHaveLength(1)
  })

  it('fails when the expected text is missing or there is nothing to scan', () => {
    const root = build({ 'static/chunks/app.js': 'no url here' })
    expect(scan([root], ['auth.example.invalid']).problems[0].message).toMatch(/not found/)
    const empty = build({})
    mkdirSync(join(empty, 'static'))
    expect(scan([empty]).problems[0].message).toBe('no client files found')
    expect(scan([join(root, 'missing')]).problems[0].message).toMatch(/not a folder/)
  })
})
