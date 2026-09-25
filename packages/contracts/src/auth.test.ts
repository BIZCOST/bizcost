import { describe, expect, it } from 'vitest'
import { secureSessionCookies } from './auth'

describe('secureSessionCookies', () => {
  it('marks session cookies Secure on https and on localhost', () => {
    expect(secureSessionCookies('https://app.example.com/login')).toBe(true)
    expect(secureSessionCookies('http://localhost:3000/')).toBe(true)
    expect(secureSessionCookies({ href: 'http://127.0.0.1:3100/account' })).toBe(true)
    expect(secureSessionCookies('http://[::1]:3000/')).toBe(true)
  })

  it('not on plain http to another host (a phone on the LAN), where browsers would drop them', () => {
    expect(secureSessionCookies('http://192.168.1.20:3000/login')).toBe(false)
    expect(secureSessionCookies('http://localhost.example.com/')).toBe(false)
    expect(secureSessionCookies('http://user@192.168.1.20/')).toBe(false)
    expect(secureSessionCookies('not a url')).toBe(false)
  })
})
