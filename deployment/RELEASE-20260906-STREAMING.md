# Incremental workbench replies

Sending previously incremented a refresh revision that cleared the entire transcript and restarted replay from zero. The frontend now retains message nodes and the event cursor, shows the new question immediately, appends reply chunks and displays actual tool operations with a spinner and elapsed time. Interrupted reads recover without erasing history. Account/session changes retain the existing isolation rules.

The platform's public and account model bridges now negotiate actual provider streaming. Harness persists each public text chunk before browser replay and waits for the validated, accounted final result. Raw reasoning/tool arguments stay off the display stream. See [ADR-0013](../docs/adr/0013-incremental-cloud-replies.md). Browser updates use incremental 500ms polling, so chunk visibility also depends on network and backend response time.

Windows verification: typecheck/lint/build, full unit suite, streaming browser checks at 1280/390/320px and account/menu/plugin regression at 1280/1920/390/320px. Browser fixtures cover retained DOM, immediate send state, tool spinner, partial text, transient failure recovery, cancellation, retained text and continuing replay cursors. Main-platform isolated Docker/MySQL tests: 46 passed. Production checks follow activation.
