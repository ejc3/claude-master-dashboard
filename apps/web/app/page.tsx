import { redirect } from 'next/navigation'
import { redirectIfMoved } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export default function Home() {
  redirectIfMoved('/claw-master')
  redirect('/claw-master')
}
