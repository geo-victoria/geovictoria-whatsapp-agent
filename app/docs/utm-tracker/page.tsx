import { readFileSync } from "fs"
import { join } from "path"

export const metadata = {
  title: "Vicky UTM Tracker — Guía de integración | GeoVictoria",
}

export default function UTMTrackerDocs() {
  const html = readFileSync(
    join(process.cwd(), "public/docs/utm-tracker.html"),
    "utf-8"
  )

  // Extract body content and styles
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/)
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)

  const styles = styleMatch?.[1] ?? ""
  const body = bodyMatch?.[1] ?? ""

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </>
  )
}
