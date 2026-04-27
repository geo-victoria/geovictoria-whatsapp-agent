import "./globals.css"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "GeoVictoria WhatsApp Agent",
  description: "Proyecto aislado para Vic + webhook WhatsApp",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
