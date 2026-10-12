/**
 * Where a page moved to, when this Worker's DASHBOARD_MOVED_TO names another origin: the old
 * address after the rename (claude-master-dashboard) sends its pages on to the same page at the new
 * one, so bookmarks keep working until it is retired. Only an https origin counts; anything else
 * (unset, a path, another scheme) leaves the page where it is, as does a path that is not this
 * site's own.
 */
export function movedTo(movedOrigin: string | undefined, path: string): string | null {
  if (movedOrigin === undefined || movedOrigin === '') return null
  let origin: URL
  try {
    origin = new URL(movedOrigin)
  } catch {
    return null
  }
  if (origin.protocol !== 'https:') return null
  // A path of this site only: '//host/...' would name another origin.
  if (!path.startsWith('/') || path.startsWith('//')) return null
  return `${origin.origin}${path}`
}
