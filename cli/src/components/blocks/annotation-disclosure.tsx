import React, { type ReactNode } from 'react'
import { Button } from '../button'
import { useTheme } from '../../hooks/use-theme'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { createTextDocument } from '../../utils/output-document'

function AnnotationDisclosure({ source, id }: { source: string; id: string }) {
  const theme = useTheme()
  return (
    <Button
      onClick={() =>
        useOutputReaderStore
          .getState()
          .open({
            document: createTextDocument({
              id: `${id}:annotations`,
              title: 'Captured text with annotations',
              text: source,
            }),
          })
      }
    >
      <text fg={theme.muted}>Annotations folded · Inspect original text</text>
    </Button>
  )
}

export function withAnnotationDisclosure(
  node: ReactNode,
  source: string,
  displayed: string,
  id: string,
): ReactNode {
  if (source === displayed) return node
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      <AnnotationDisclosure source={source} id={id} />
      {node}
    </box>
  )
}
