---
"@mirk/store-postgres": patch
---

Order keys and sorted string fields by Unicode code point on every PostgreSQL server, as the store contract requires, instead of by the database's collation. Databases with a language collation such as `en_US.UTF-8` return a different order than before: uppercase before lowercase, and characters outside the Basic Multilingual Plane after every other character.
