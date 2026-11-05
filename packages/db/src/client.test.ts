import { describe, expect, it } from 'vitest'
import { tlsFor } from './client'

const HOSTED = 'postgresql://bizcost_api.ref:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres'
const CA = '-----BEGIN CERTIFICATE-----\nnot a real one\n-----END CERTIFICATE-----'

describe('tlsFor (D-353, D-362)', () => {
  it('verifies a hosted database against its CA', () => {
    expect(tlsFor(HOSTED, CA)).toEqual({ ca: CA, rejectUnauthorized: true })
  })

  it('refuses a hosted database with no way to check who answers', () => {
    expect(() => tlsFor(HOSTED)).toThrow(/DATABASE_CA_CERT/)
    expect(() => tlsFor(`${HOSTED}?sslmode=require`)).toThrow(/DATABASE_CA_CERT/)
  })

  it('verifies with the CA even when the URL asks only for encryption', () => {
    expect(tlsFor(`${HOSTED}?sslmode=require`, CA)).toEqual({ ca: CA, rejectUnauthorized: true })
  })

  it('refuses a hosted database in the clear, whatever else is given', () => {
    expect(() => tlsFor(`${HOSTED}?sslmode=disable`, CA)).toThrow(/sslmode=disable/)
    expect(() => tlsFor(`${HOSTED}?sslmode=disable`)).toThrow(/sslmode=disable/)
  })

  it('leaves a database on this machine as it is', () => {
    expect(tlsFor('postgresql://bizcost_api:pw@127.0.0.1:54322/postgres')).toBeUndefined()
    expect(tlsFor('postgresql://bizcost_api:pw@localhost:54322/postgres')).toBeUndefined()
    expect(tlsFor('postgresql://bizcost_api:pw@[::1]:54322/postgres')).toBeUndefined()
    expect(tlsFor('postgresql://u:p@127.0.0.1:5432/postgres?sslmode=disable')).toBeUndefined()
  })

  it('keeps verify-full when the URL asks for it, against the system list', () => {
    expect(
      tlsFor('postgresql://u:p@db.example.test:5432/postgres?sslmode=verify-full'),
    ).toBeUndefined()
  })
})
