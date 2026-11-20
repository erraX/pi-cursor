# Cursor agent wire schema

`agent.proto` is the reverse-engineered schema for Cursor's `agent.v1` service. It is the
**source of truth** for `src/proto/agent_pb.ts`, which is generated and must never be
hand-edited.

## Regenerating the TypeScript

```bash
yarn proto:gen     # proto/agent.proto -> src/proto/agent_pb.ts
yarn proto:check   # fails if src/proto/agent_pb.ts is stale (runs in yarn check)
```

Both use `buf` and `protoc-gen-es` from devDependencies, so no system `protoc` is needed.

## When Cursor changes the schema

Cursor can change the agent schema at any time. There are two ways to pick that up:

1. **You have an updated `.proto`.** Edit `agent.proto`, then `yarn proto:gen`.

2. **You only have an updated generated file** (the common case — the schema is recovered
   from a Cursor client build). Drop the new `agent_pb.ts` into `src/proto/`, then:

   ```bash
   yarn proto:sync    # rebuild agent.proto from the new generated file
   yarn proto:check   # prove the two now agree
   ```

   `proto:sync` works because `protoc-gen-es` embeds the complete `FileDescriptorProto`
   in its output, so the generated file carries the whole schema losslessly.
   `scripts/proto-descriptor.ts` decodes it and prints proto3 source.

The client announces a Cursor CLI build in `x-cursor-client-version`
(`DEFAULT_CURSOR_CLIENT_VERSION` in `src/config/index.ts`), and Cursor gates protocol features
on it. Keep it at the build the schema was synced from, and raise it only after a live run
(`yarn smoke:stream`, a Pi tool call) shows no new drift.

## Naming one unknown field

The lifecycle log and `/cursor.doctor` report drift as `<message>.payload#<field numbers>`, for
example `conversationCheckpointUpdate.payload#38,39,46`. When only a few fields are missing, an
installed Cursor CLI is enough to name them. Its bundle
(`~/.local/share/cursor-agent/versions/<version>/index.js`) lists every message in a compact
form:

```text
"ConversationStateStructure|1 root_prompt_messages_json 12*|...|38 recent_user_message_ids 9*|39 recent_user_message_ids_older_turn_count 13?|..."
```

Each entry is `<number> <name> <type>`. The type is the protobuf scalar type number (`4` uint64,
`8` bool, `9` string, `12` bytes, `13` uint32) or `#n`, a reference to another message; `*`
marks repeated, `?` optional, and a trailing word names the oneof. Add the field to
`agent.proto` under the same number and run `yarn proto:gen`. Append new messages after the
last existing one, so the generated file changes only where the schema did.

A field number the CLI does not list either means the server is ahead of that CLI build.

## Scope of the printer

`scripts/proto-descriptor.ts` handles the subset this schema uses: messages, nested
types, enums, oneofs, proto3 `optional`, maps, reserved ranges, and services. It throws
rather than silently dropping anything outside that — imports, extensions, groups, field
defaults, and custom options are all rejected. If Cursor's schema ever grows one of
those, extend the printer; `proto:check` will catch the mismatch either way.
