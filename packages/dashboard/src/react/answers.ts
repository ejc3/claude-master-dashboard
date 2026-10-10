import { useRef } from 'react'
import type { Series, TimeRange } from '../core'
import type { Loaded } from './hooks'

export interface SharedAnswers<K extends string> {
  /** The range every answer covers. */
  range: TimeRange
  /** Each answer, cut to that range. */
  data: Record<K, Series[]>
}

/**
 * Answers shown together, cut to the range all of them cover. While a moved range loads, one
 * query can show its new answer and another its last one, a step behind; combined as they are,
 * the newest bucket would count in one and read as zero in the other (a 0% error rate). Null
 * until every answer is ready.
 */
export function sharedAnswers<K extends string>(
  answers: Record<K, Loaded<Series[]>>,
): SharedAnswers<K> | null {
  const entries = Object.entries(answers) as Array<[K, Loaded<Series[]>]>
  let start = Number.NEGATIVE_INFINITY
  let end = Number.POSITIVE_INFINITY
  const ready: Array<[K, Series[]]> = []
  for (const [key, loaded] of entries) {
    if (loaded.state !== 'ready' || loaded.range === undefined) return null
    start = Math.max(start, loaded.range.start)
    end = Math.min(end, loaded.range.end)
    ready.push([key, loaded.data])
  }
  if (ready.length === 0 || !(start < end)) return null
  const within = (series: Series[]) =>
    series.map((s) => ({ ...s, points: s.points.filter(([t]) => t >= start && t < end) }))
  return {
    range: { start, end },
    data: Object.fromEntries(ready.map(([key, series]) => [key, within(series)])) as Record<
      K,
      Series[]
    >,
  }
}

/** sharedAnswers, the same object until an answer or its range changes. */
export function useSharedAnswers<K extends string>(
  answers: Record<K, Loaded<Series[]>>,
): SharedAnswers<K> | null {
  const inputs = Object.values<Loaded<Series[]>>(answers).flatMap((l): unknown[] =>
    l.state === 'ready' ? [l.data, l.range?.start, l.range?.end] : [l.state],
  )
  const kept = useRef<{ inputs: unknown[]; shared: SharedAnswers<K> | null } | null>(null)
  const same =
    kept.current !== null &&
    kept.current.inputs.length === inputs.length &&
    kept.current.inputs.every((v, i) => v === inputs[i])
  if (!same || kept.current === null) kept.current = { inputs, shared: sharedAnswers(answers) }
  return kept.current.shared
}
