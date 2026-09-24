---
'watch-tail': minor
---

Historic views now prefer the local archive. With **CloudWatch** selected, a historic window reads
the events the archive already holds and only asks CloudWatch for the ranges it has never seen, so
re-investigating a window is faster and uses less AWS. watch-tail records which ranges it actually
read from CloudWatch (following every result page) and stored, so it never skips a period it did
not stream: uncovered gaps are always fetched from AWS, and so are the last five minutes of any
read, because CloudWatch can still be ingesting them. A range is never recorded when its events
could not be written. A CloudWatch historic view now also honours `max` across all its groups. A CloudWatch **filter
pattern** keeps a request entirely on the API, because that scan archived only the matching lines,
and **Local archive** is still how you read windows older than CloudWatch's 14-day limit.
