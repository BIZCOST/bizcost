import type { Metadata } from 'next'
import { HomeView } from '@/features/home/home-view'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.home') }
}

export default function HomePage() {
  return <HomeView />
}
