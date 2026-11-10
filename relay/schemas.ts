import type { GenericSchema } from 'valibot'
import {
  array,
  boolean,
  literal,
  number,
  object,
  parseJson,
  picklist,
  pipe,
  regex,
  string,
  trim,
  variant,
} from 'valibot'

import type { BridgeToRelay, ViewerToRelay } from '../plugin/types/protocol'

const MODE = picklist(['read', 'edit'])
const TOKEN_INFO = { hash: string(), mode: MODE, expires: number() }

export const SID = pipe(string(), regex(/^[\w-]{8,32}$/u))

export const VIEWER_MESSAGE = pipe(
  string(),
  parseJson(),
  variant('type', [
    object({ type: literal('auth'), token: string() }),
    object({ type: literal('prompt'), text: pipe(string(), trim()) }),
  ]),
) satisfies GenericSchema<string, ViewerToRelay>

export const BRIDGE_MESSAGE = pipe(
  string(),
  parseJson(),
  variant('type', [
    object({ type: literal('hello'), tokens: array(object(TOKEN_INFO)) }),
    object({ type: literal('token.add'), ...TOKEN_INFO }),
    object({ type: literal('token.revoke'), hash: string() }),
    object({
      type: literal('frame'),
      bytes: string(),
      full: boolean(),
      width: number(),
      height: number(),
      seq: number(),
    }),
    variant('outcome', [
      object({ type: literal('queued'), viewer: string(), outcome: literal('sent') }),
      object({ type: literal('queued'), viewer: string(), outcome: literal('pending') }),
      object({
        type: literal('queued'),
        viewer: string(),
        outcome: literal('refused'),
        why: string(),
      }),
    ]),
    object({ type: literal('end') }),
  ]),
) satisfies GenericSchema<string, BridgeToRelay>
