import '@ejc3/claude-master-dashboard/styles.css'
import './globals.css'

import type { Metadata, Viewport } from 'next'
import { Barlow, Barlow_Condensed } from 'next/font/google'
import type { ReactNode } from 'react'

const sans = Barlow({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--cmd-font-sans',
})
const condensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--cmd-font-condensed',
})

export const metadata: Metadata = {
  title: 'claude-master',
  description: 'Subscription headroom, resets and traffic for a claude-master pool.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef1f4' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1520' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${condensed.variable}`}>
      <body>{children}</body>
    </html>
  )
}
