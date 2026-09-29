import { describe, expect, it } from 'vitest'
import { orderCategories, pickableCategories } from './categories'

// The shared categories in the order people look for them (D-167): the owner's starter list in its
// order, the business's own after it, "Other" last.

const STARTERS = ['Rent', 'Electricity', 'Water', 'Salaries', 'Other']
const cat = (name: string, archived = false) => ({
  id: name,
  name,
  archivedAt: archived ? '2026-09-29T10:00:00.000Z' : null,
})

describe('orderCategories', () => {
  it('puts the starter list first in its order, the business’s own next, Other last', () => {
    // As the API lists them: by name.
    const byName = ['Cleaning', 'Electricity', 'Other', 'Rent', 'Salaries', 'Travel', 'Water'].map(
      (name) => cat(name),
    )
    expect(orderCategories(byName, STARTERS).map((c) => c.name)).toEqual([
      'Rent',
      'Electricity',
      'Water',
      'Salaries',
      'Cleaning',
      'Travel',
      'Other',
    ])
  })

  it('matches names as people read them; a starter renamed sorts with the business’s own', () => {
    const categories = [cat('Office rent'), cat('  RENT '), cat('Ｗater')]
    expect(orderCategories(categories, STARTERS).map((c) => c.name)).toEqual([
      '  RENT ',
      'Ｗater',
      'Office rent',
    ])
  })

  it('in Arabic too', () => {
    const arabic = ['الإيجار', 'الكهرباء', 'أخرى']
    const categories = [cat('أخرى'), cat('التنظيف'), cat('الكهرباء'), cat('الإيجار')]
    expect(orderCategories(categories, arabic).map((c) => c.name)).toEqual([
      'الإيجار',
      'الكهرباء',
      'التنظيف',
      'أخرى',
    ])
  })
})

describe('pickableCategories', () => {
  it('offers the active ones and the archived one the record already has', () => {
    const categories = [cat('Rent'), cat('Old', true), cat('Gone', true)]
    expect(pickableCategories(categories, '').map((c) => c.name)).toEqual(['Rent'])
    expect(pickableCategories(categories, 'Old').map((c) => c.name)).toEqual(['Rent', 'Old'])
  })
})
