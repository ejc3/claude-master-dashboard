import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// The dashboard's address before the rename: on to the same page at the new one.
export default async function Old({ params }: { params: Promise<{ slug?: string[] }> }) {
  const rest = ((await params).slug ?? []).map(encodeURIComponent).join('/')
  redirect(rest === '' ? '/claw-master' : `/claw-master/${rest}`)
}
