import type { Register } from 'claude-code'

import { runCommand } from './commands'
import { resetState, settle, shareState, waitingGuests } from './control'
import { oneLine, statusText } from './text'

export const register: Register = (on) => {
  on('session.start', async ($, event, next) => {
    await $.command.register({
      name: 'share-session',
      description: 'Share this session as a live web link (read or edit)',
      argumentHint:
        'read|edit [ttl] [--mode approve|auto] | approve|reject [all] | list | revoke | stop',
      immediate: true,
    })
    await resetState($)

    return next(event)
  })

  on('command.run', { command: 'share-session' }, async ($, event) => ({
    text: await runCommand($, event.args),
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    const [first, ...others] = await waitingGuests($)
    const state = await shareState($)

    if (event.props.hasSurvey || (first === undefined && state.socket === null)) {
      return next(event)
    }

    const { Box, Button, Text } = $.ui.resolve(event)

    if (first === undefined) {
      return (
        <Box flexDirection="column">
          {await next(event)}
          <Text dimColor>
            {statusText(state).replace('session-share', 'sharing session')}
            {state.page === null ? '' : ` · ${state.page.replace(/^https?:\/\//u, '')}`}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text>
          <Text color="yellow" weight="semibold">
            session-share guest wants to send
          </Text>
          {others.length > 0 ? <Text dimColor> (+{others.length} more)</Text> : null}
        </Text>
        <Text>{oneLine(first.text)}</Text>
        <Box gap={2}>
          <Button
            key="approve"
            hotkey="y"
            label="approve"
            variant="primary"
            onPress={() => {
              void settle($, 'approve', false)
            }}
          />
          <Button
            key="reject"
            hotkey="n"
            label="reject"
            onPress={() => {
              void settle($, 'reject', false)
            }}
          />
          {others.length > 0 ? (
            <Button
              key="approve-all"
              hotkey="a"
              label="approve all"
              onPress={() => {
                void settle($, 'approve', true)
              }}
            />
          ) : null}
          <Text dimColor>ctrl+x tab to focus · /share-session approve|reject [all]</Text>
        </Box>
      </Box>
    )
  })
}
