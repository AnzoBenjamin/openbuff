import { describe, expect, it } from 'bun:test'

import {
  createStreamParserState,
  finalizeStreamParserState,
  parseStreamChunk,
  toBoundedRawExcerpt,
} from '../stream-xml-parser'

describe('stream-xml-parser', () => {
  describe('parseStreamChunk', () => {
    it('should pass through plain text without tool calls', () => {
      const state = createStreamParserState()
      const result = parseStreamChunk('Hello, world!', state)

      expect(result.filteredText).toBe('Hello, world!')
      expect(result.toolCalls).toEqual([])
    })

    it('should extract a complete tool call in a single chunk', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
{"cb_tool_name": "test_tool", "path": "foo.ts"}
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
      expect(result.toolCalls[0].input).toEqual({ path: 'foo.ts' })
    })

    it('should extract tool call and preserve text before and after', () => {
      const state = createStreamParserState()
      const chunk = `Before text
<codebuff_tool_call>
{"cb_tool_name": "test_tool"}
</codebuff_tool_call>
After text`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('Before text\n\nAfter text')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
    })

    // Both parsers share resolveToolName: models respell the injected
    // cb_tool_name constantly, so a respelled name is a real call, not a
    // reason to discard the block.
    describe('tool-name aliases', () => {
      it('should resolve the tool name from a respelled alias key', () => {
        const state = createStreamParserState()
        const chunk = `<codebuff_tool_call>
{"tool_name": "test_tool", "path": "foo.ts"}
</codebuff_tool_call>`

        const result = parseStreamChunk(chunk, state)

        expect(result.errors).toEqual([])
        expect(result.toolCalls).toHaveLength(1)
        expect(result.toolCalls[0].toolName).toBe('test_tool')
        expect(result.toolCalls[0].input).toEqual({ path: 'foo.ts' })
        expect(result.toolCalls[0].input).not.toHaveProperty('tool_name')
      })

      it('should prefer cb_tool_name over a conflicting alias', () => {
        const state = createStreamParserState()
        const chunk = `<codebuff_tool_call>
{"cb_tool_name": "test_tool", "name": "not-a-tool"}
</codebuff_tool_call>`

        const result = parseStreamChunk(chunk, state)

        expect(result.toolCalls).toHaveLength(1)
        expect(result.toolCalls[0].toolName).toBe('test_tool')
        expect(result.toolCalls[0].input).toEqual({ name: 'not-a-tool' })
      })

      it('should keep a param that shares an alias spelling (skill.name)', () => {
        const state = createStreamParserState()
        const chunk = `<codebuff_tool_call>
{"cb_tool_name": "skill", "name": "release"}
</codebuff_tool_call>`

        const result = parseStreamChunk(chunk, state)

        expect(result.errors).toEqual([])
        expect(result.toolCalls).toHaveLength(1)
        expect(result.toolCalls[0].toolName).toBe('skill')
        expect(result.toolCalls[0].input).toEqual({ name: 'release' })
      })

      it('should report missing_tool_name when no tool-name key is present', () => {
        const state = createStreamParserState()
        const chunk = `<codebuff_tool_call>
{"paths": ["a.ts"]}
</codebuff_tool_call>`

        const result = parseStreamChunk(chunk, state)

        expect(result.toolCalls).toEqual([])
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0].code).toBe('missing_tool_name')
        expect(result.errors[0].message).toBe(
          'Ignored codebuff_tool_call content because no tool-name key was present as a non-empty string.',
        )
        // The raw block is quoted back as a bounded excerpt so the model can
        // diff its malformed input instead of repeating it
        // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
        expect(result.errors[0].rawExcerpt).toBe('\n{"paths": ["a.ts"]}\n')
      })
    })

    it('should handle tool call split across multiple chunks', () => {
      const state = createStreamParserState()

      // First chunk: start tag and partial content
      const result1 = parseStreamChunk('<codebuff_tool_call>\n{"cb_tool', state)
      expect(result1.filteredText).toBe('')
      expect(result1.toolCalls).toEqual([])

      // Second chunk: rest of content and end tag
      const result2 = parseStreamChunk(
        '_name": "test_tool"}\n</codebuff_tool_call>',
        state,
      )
      expect(result2.filteredText).toBe('')
      expect(result2.toolCalls).toHaveLength(1)
      expect(result2.toolCalls[0].toolName).toBe('test_tool')
    })

    it('should handle partial start tag at chunk boundary', () => {
      const state = createStreamParserState()

      // First chunk ends with partial start tag
      const result1 = parseStreamChunk('Some text<codebuff', state)
      expect(result1.filteredText).toBe('Some text')
      expect(result1.toolCalls).toEqual([])

      // Second chunk completes the start tag
      const result2 = parseStreamChunk(
        '_tool_call>\n{"cb_tool_name": "test"}\n</codebuff_tool_call>',
        state,
      )
      expect(result2.filteredText).toBe('')
      expect(result2.toolCalls).toHaveLength(1)
    })

    it('should handle multiple tool calls in sequence', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
{"cb_tool_name": "tool_a"}
</codebuff_tool_call>
Middle text
<codebuff_tool_call>
{"cb_tool_name": "tool_b"}
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('\nMiddle text\n')
      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].toolName).toBe('tool_a')
      expect(result.toolCalls[1].toolName).toBe('tool_b')
    })

    it('should handle empty chunks', () => {
      const state = createStreamParserState()
      const result = parseStreamChunk('', state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toEqual([])
    })

    it('should remove cb_easp from input', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
{"cb_tool_name": "test", "cb_easp": true, "path": "foo.ts"}
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].input).toEqual({ path: 'foo.ts' })
      expect(result.toolCalls[0].input).not.toHaveProperty('cb_easp')
    })

    it('should handle tool call without newlines after/before tags', () => {
      const state = createStreamParserState()
      // No newline after start tag or before end tag
      const chunk = `<codebuff_tool_call>{"cb_tool_name": "test_tool"}</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
    })

    it('should handle tool call with CRLF line endings', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>\r\n{"cb_tool_name": "test_tool"}\r\n</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
    })

    it('should handle tool call with extra whitespace', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>  
  {"cb_tool_name": "test_tool"}  
  </codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
    })

    it('should tolerate markdown fences and trailing commas inside tool call JSON', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
\`\`\`json
{
  "cb_tool_name": "test_tool",
  "path": "foo.ts",
  "items": [
    "a",
  ],
}
\`\`\`
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
      expect(result.toolCalls[0].input).toEqual({
        path: 'foo.ts',
        items: ['a'],
      })
    })

    it('should not rewrite comma-brace sequences inside valid JSON strings', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
{"cb_tool_name": "test_tool", "content": "keep ,} and ,] intact"}
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].input).toEqual({
        content: 'keep ,} and ,] intact',
      })
    })

    it('should extract the JSON object when extra text appears inside the tool call tag', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
Here is the edit:
{"cb_tool_name": "test_tool", "path": "foo.ts"}
Done.
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
      expect(result.toolCalls[0].input).toEqual({ path: 'foo.ts' })
    })

    it('should handle realistic streaming scenario with small chunks', () => {
      const state = createStreamParserState()
      const allChunks: string[] = []
      const allToolCalls: any[] = []

      // Simulate streaming in small chunks like a real LLM would
      const fullText = `<think>
Thinking about the task...
</think>

<codebuff_tool_call>
{"cb_tool_name": "str_replace", "path": "test.ts"}
</codebuff_tool_call>`

      // Stream in ~10 char chunks
      for (let i = 0; i < fullText.length; i += 10) {
        const chunk = fullText.slice(i, i + 10)
        const result = parseStreamChunk(chunk, state)
        allChunks.push(result.filteredText)
        allToolCalls.push(...result.toolCalls)
      }

      const combinedText = allChunks.join('')
      expect(combinedText).toBe(
        '<think>\nThinking about the task...\n</think>\n\n',
      )
      expect(allToolCalls).toHaveLength(1)
      expect(allToolCalls[0].toolName).toBe('str_replace')
      expect(allToolCalls[0].input.path).toBe('test.ts')
    })

    it('should handle end tag split across chunks', () => {
      const state = createStreamParserState()
      const allChunks: string[] = []
      const allToolCalls: any[] = []

      // Send start tag and content
      let result = parseStreamChunk(
        '<codebuff_tool_call>\n{"cb_tool_name": "test"}\n</',
        state,
      )
      allChunks.push(result.filteredText)
      allToolCalls.push(...result.toolCalls)

      // Send rest of end tag
      result = parseStreamChunk('codebuff_tool_call>', state)
      allChunks.push(result.filteredText)
      allToolCalls.push(...result.toolCalls)

      expect(allToolCalls).toHaveLength(1)
      expect(allToolCalls[0].toolName).toBe('test')
    })

    it('should report empty codebuff_tool_call content with the untrimmed between-tags excerpt', () => {
      // Direct pin for the empty-content branch in parseToolCallContent:
      // whitespace-only content trims to nothing, so the call is reported as
      // invalid JSON — never silently dropped — and rawExcerpt is the
      // UNTRIMMED between-tags content, so the model sees the whitespace-only
      // block it actually emitted.
      const state = createStreamParserState()
      const result = parseStreamChunk(
        '<codebuff_tool_call>   </codebuff_tool_call>',
        state,
      )

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toEqual([])
      expect(result.errors).toEqual([
        {
          code: 'invalid_tool_call_json',
          message: 'Ignored empty codebuff_tool_call content.',
          rawExcerpt: '   ',
        },
      ])
    })

    it('should parse a single-chunk complete call whose scanned bytes exceed the buffer limit', () => {
      // Invariant pin for the overflow branch: maxToolCallBufferLength bounds
      // BUFFERED (unterminated) bytes only. A call whose end tag is found in
      // the same scan parses regardless of size, so the limit never fires for
      // a complete call — only for one still waiting for its closing tag.
      const state = createStreamParserState({ maxToolCallBufferLength: 32 })
      const chunk = `<codebuff_tool_call>${JSON.stringify({
        cb_tool_name: 'test_tool',
      })}</codebuff_tool_call>`
      // The whole call arrives in one chunk, so the bytes the overflow check
      // would see exceed the limit — the pin has teeth.
      expect(chunk.length).toBeGreaterThan(32)

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.errors).toEqual([])
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
    })

    it('should report invalid JSON inside a completed tool call', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
{"cb_tool_name": "test_tool",
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toEqual([])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe('invalid_tool_call_json')
      expect(result.errors[0].message).toContain('JSON parsing failed')
      // The raw block is quoted back as a bounded excerpt so the model can
      // diff its malformed input
      // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
      expect(result.errors[0].rawExcerpt).toBe(
        '\n{"cb_tool_name": "test_tool",\n',
      )
    })

    it('should report and discard unterminated tool call buffers past the limit', () => {
      const state = createStreamParserState({ maxToolCallBufferLength: 8 })

      const result = parseStreamChunk('<codebuff_tool_call>123456789', state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toEqual([])
      expect(result.errors).toEqual([
        {
          code: 'tool_call_buffer_exceeded',
          message:
            'Discarded unterminated codebuff_tool_call content after 9 buffered characters (limit 8). Discarding content until the end tag.',
          bufferedLength: 9,
          maxBufferLength: 8,
          // Bounded excerpt of the payload, captured BEFORE the discard reset
          // destroys it — the only surviving evidence of what the model
          // emitted
          // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
          rawExcerpt: '123456789',
        },
      ])
      expect(state.buffer).toBe('')
      // Overflow stays in a discard-until-end-tag scanning state; the parser
      // only returns to normal mode after the closing tag is consumed.
      expect(state.insideToolCall).toBe(true)
      expect(state.discardingUntilEndTag).toBe(true)
    })

    it('captures the overflow excerpt from retained and fresh bytes before discarding', () => {
      const state = createStreamParserState({ maxToolCallBufferLength: 8 })

      // First chunk stays under the limit and is retained in the buffer.
      const result1 = parseStreamChunk('<codebuff_tool_call>12345', state)
      expect(result1.errors).toEqual([])

      // Second chunk overflows: the excerpt must combine the retained buffer
      // with the fresh bytes BEFORE the discard reset destroys them, or the
      // payload is unrecoverable
      // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
      const result2 = parseStreamChunk('6789', state)
      expect(result2.errors).toEqual([
        {
          code: 'tool_call_buffer_exceeded',
          message:
            'Discarded unterminated codebuff_tool_call content after 9 buffered characters (limit 8). Discarding content until the end tag.',
          bufferedLength: 9,
          maxBufferLength: 8,
          rawExcerpt: '123456789',
        },
      ])

      // Fail-safe unchanged: the discarded payload never leaks as filtered
      // text and the end tag is still consumed silently.
      const result3 = parseStreamChunk('</codebuff_tool_call>done', state)
      expect(result3.filteredText).toBe('done')
      expect(result3.errors).toEqual([])
    })

    it('should swallow the end tag after a buffer overflow instead of leaking it into text', () => {
      const state = createStreamParserState({ maxToolCallBufferLength: 8 })

      const result1 = parseStreamChunk('<codebuff_tool_call>123456789', state)
      expect(result1.errors).toHaveLength(1)

      const result2 = parseStreamChunk('\n</codebuff_tool_call>done', state)

      expect(result2.filteredText).toBe('done')
      expect(result2.toolCalls).toEqual([])
      expect(result2.errors).toEqual([])
      expect(state.discardingUntilEndTag).toBe(false)
      expect(state.insideToolCall).toBe(false)
    })

    it('should handle an end tag split across chunks after a buffer overflow', () => {
      const state = createStreamParserState({ maxToolCallBufferLength: 4 })

      parseStreamChunk('<codebuff_tool_call>abcdef', state)
      const result = parseStreamChunk('</codebuff_', state)
      const final = parseStreamChunk('tool_call>after', state)

      expect(final.filteredText).toBe('after')
      expect(final.toolCalls).toEqual([])
      expect(final.errors).toEqual([])
    })

    it('should extract the balanced JSON object when prose contains braces', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
use {x} like this: {"cb_tool_name": "test_tool", "path": "foo.ts"} hope that helps
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.filteredText).toBe('')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe('test_tool')
      expect(result.toolCalls[0].input).toEqual({ path: 'foo.ts' })
    })

    it('should not truncate the JSON object at a brace inside a string literal', () => {
      const state = createStreamParserState()
      const chunk = `<codebuff_tool_call>
{"cb_tool_name": "test_tool", "content": "literal { brace"} tail "{
</codebuff_tool_call>`

      const result = parseStreamChunk(chunk, state)

      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].input).toEqual({
        content: 'literal { brace',
      })
    })
  })

  describe('toBoundedRawExcerpt', () => {
    // The excerpt is the only surviving evidence of a malformed tool call,
    // and its bound is part of the fail-safe contract: a 64 KiB overflow must
    // not balloon the error message or the transcript
    // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
    it('returns content up to 500 characters verbatim', () => {
      expect(toBoundedRawExcerpt('')).toBe('')
      expect(toBoundedRawExcerpt('short')).toBe('short')
      expect(toBoundedRawExcerpt('x'.repeat(500))).toBe('x'.repeat(500))
    })

    it('truncates longer content to first 250 + marker + last 250', () => {
      const content = 'abcdefghij'.repeat(100) // 1000 characters
      expect(toBoundedRawExcerpt(content)).toBe(
        `${content.slice(0, 250)}…[${
          content.length - 500
        } chars truncated]…${content.slice(-250)}`,
      )
    })

    it('reports exactly length-minus-500 truncated characters', () => {
      const content = 'y'.repeat(501)
      expect(toBoundedRawExcerpt(content)).toBe(
        `${'y'.repeat(250)}…[1 chars truncated]…${'y'.repeat(250)}`,
      )
    })
  })

  describe('finalizeStreamParserState', () => {
    // End-of-stream gap closure
    // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md):
    // a <codebuff_tool_call> whose closing tag never arrives used to be
    // dropped with ZERO feedback unless it overflowed the buffer, and the
    // outside-call partial-tag carry vanished at EOF.
    it('reports one tool_call_unterminated_eof with a bounded excerpt and resets state', () => {
      const payload = '\n{"cb_tool_name": "test_tool",\n'
      const state = createStreamParserState()
      // The stream ends mid-call, under the buffer limit: no overflow error
      // fired, so the payload is retained inside the parser state.
      const parsed = parseStreamChunk(`<codebuff_tool_call>${payload}`, state)
      expect(parsed.errors).toEqual([])
      expect(state.insideToolCall).toBe(true)

      const finalized = finalizeStreamParserState(state)

      expect(finalized.filteredText).toBe('')
      expect(finalized.errors).toEqual([
        {
          code: 'tool_call_unterminated_eof',
          message: `Discarded unterminated codebuff_tool_call content at end of stream after ${payload.length} buffered characters: the response ended before the closing tag.`,
          bufferedLength: payload.length,
          // Bounded excerpt of the dropped payload, captured BEFORE the
          // reset destroys it — the only surviving evidence of what the
          // model emitted
          // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
          rawExcerpt: payload,
        },
      ])
      // Reset: the payload is reported as dropped tool-call content and
      // never leaks as text.
      expect(state.buffer).toBe('')
      expect(state.insideToolCall).toBe(false)
      expect(state.discardingUntilEndTag).toBe(false)
    })

    it('bounds the EOF excerpt of a large unterminated payload', () => {
      const payload = 'x'.repeat(600)
      const state = createStreamParserState()
      parseStreamChunk(`<codebuff_tool_call>${payload}`, state)

      const finalized = finalizeStreamParserState(state)

      expect(finalized.errors).toHaveLength(1)
      expect(finalized.errors[0].code).toBe('tool_call_unterminated_eof')
      expect(finalized.errors[0].bufferedLength).toBe(payload.length)
      // Fail-safe excerpt bound: a large dropped payload cannot balloon the
      // error message, exactly like the other parser error sites.
      expect(finalized.errors[0].rawExcerpt).toBe(toBoundedRawExcerpt(payload))
    })

    it('emits no duplicate error when discarding after a buffer overflow at EOF', () => {
      const state = createStreamParserState({ maxToolCallBufferLength: 8 })
      const overflow = parseStreamChunk('<codebuff_tool_call>123456789', state)
      expect(overflow.errors).toHaveLength(1)
      expect(overflow.errors[0].code).toBe('tool_call_buffer_exceeded')
      expect(state.insideToolCall).toBe(true)
      expect(state.discardingUntilEndTag).toBe(true)

      const finalized = finalizeStreamParserState(state)

      // The overflow already reported this content: no duplicate error and
      // nothing leaks as text at EOF.
      expect(finalized.filteredText).toBe('')
      expect(finalized.errors).toEqual([])
      expect(state.buffer).toBe('')
      expect(state.insideToolCall).toBe(false)
      expect(state.discardingUntilEndTag).toBe(false)
    })

    it('returns empty for a clean state at end of stream', () => {
      expect(finalizeStreamParserState(createStreamParserState())).toEqual({
        filteredText: '',
        errors: [],
      })

      const state = createStreamParserState()
      parseStreamChunk('fully emitted prose', state)
      expect(finalizeStreamParserState(state)).toEqual({
        filteredText: '',
        errors: [],
      })
    })

    it('flushes the outside-call partial-tag carry as filteredText at EOF', () => {
      const state = createStreamParserState()
      // A lone '<' may still become a start tag, so the parser holds it back.
      const parsed = parseStreamChunk('partial text <', state)
      expect(parsed.filteredText).toBe('partial text ')
      expect(state.buffer).toBe('<')

      const finalized = finalizeStreamParserState(state)

      // Real prose bytes never vanish at EOF: the held carry is flushed.
      expect(finalized.filteredText).toBe('<')
      expect(finalized.errors).toEqual([])
      expect(state.buffer).toBe('')
    })
  })
})
