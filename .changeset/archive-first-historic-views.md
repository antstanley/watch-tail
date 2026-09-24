---
'watch-tail': minor
---

Historic views now prefer the local archive. With **CloudWatch** selected, a historic window reads
the events the archive already holds and only asks CloudWatch for the ranges it has never seen, so
re-investigating a window is faster and uses less AWS. watch-tail records which ranges it actually
queried and archived - a completed unfiltered scan, or a live tail's successful polls - so it never
skips a period it did not stream: uncovered gaps are always fetched from AWS. A CloudWatch **filter
pattern** keeps a request entirely on the API, because that scan archived only the matching lines,
and **Local archive** is still how you read windows older than CloudWatch's 14-day limit.
