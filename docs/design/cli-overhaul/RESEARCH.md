# CLI design references

Researched 2026-11-03. These references support the draft [DESIGN.md](../../../DESIGN.md) and [PLAN.md](PLAN.md).

The selection prioritizes information-heavy products, long-document navigation and clear live status. Recognition is verified separately from the interaction patterns described in current product documentation. An award establishes a useful reference; it does not establish that transplanting its appearance will improve a terminal interface.

## Award-verified reference set

| Reference | Surface | Verified recognition | Pattern to adapt to Openbuff |
| --- | --- | --- | --- |
| Things 3 | Mac desktop, iPhone/iPad | [Apple Design Award, 2017](https://www.apple.com/newsroom/2017/06/apple-design-awards-celebrate-the-best-in-innovation-and-creativity/) | Strong headings, quiet detail disclosure, fast navigation, focus when space is constrained |
| Bear | Mac desktop, iPhone/iPad | [Apple Design Award, 2017](https://www.apple.com/newsroom/2017/06/apple-design-awards-celebrate-the-best-in-innovation-and-creativity/) | Combine section folding, outline navigation and readable content |
| Flighty | Mobile | [Apple Design Award, Interaction, 2023](https://developer.apple.com/design/awards/2023/) | Persistent key context and understandable live state |
| Gentler Streak | Mobile | [Apple Design Award, Social Impact, 2024](https://developer.apple.com/design/awards/2024/) | Calm presentation of complicated data; summary before metrics |
| Notion | Web, desktop, mobile | [Webby Winner, Productivity & Collaboration, 2022](https://winners.webbyawards.com/2022/apps-and-software/software-services-platforms/productivity-collaboration/208566/notion) | Content blocks, headings, toggles and explicit structural navigation |
| NBC Big Board / Code and Theory | Interactive data system; awarded under websites/mobile sites | [Webby Winner, Best Data Visualization, 2025](https://winners.webbyawards.com/2025/websites-and-mobile-sites/features-design/best-data-visualization/338330/nbc-big-board-powering-data-journalism) | Turn complex evidence into an understandable story with navigable detail |

## What transfers, and how

### Things: hierarchy without a heavy shell

[Things' feature documentation](https://culturedcode.com/things/features/) describes headings for large projects, optional task fields tucked away until needed, Quick Find and a Slim Mode that hides the sidebar while retaining navigation. The CLI adaptation is a compact action/outcome row with details on demand and a reader whose outline can disappear on narrow terminals. Keep expert actions easy to find through the palette.

[Official Mac headings reference image](https://static.culturedcode.com/things/videos/2017-05-18-website-videos/4-headings-mac.png). This is a linked reference, not an Openbuff mockup.

### Bear: folding needs an outline

[Bear 2's release documentation](https://blog.bear.app/2023/07/bear-2-is-here/) documents folding headings/lists, a heading-based table of contents and find within notes. These features postdate Bear's 2017 award. Their relevance is direct: hiding long content is only half the design; users need another way to reach the hidden sections. For Openbuff, build a content-specific outline beside the reader and expose it as a picker on narrow terminals.

### Flighty: live information should remain obvious

[Apple's Flighty design case study](https://developer.apple.com/news/?id=970ncww4) describes key information kept visible and an interface drawing on familiar airport signage. Translate that to a stable action/status line, a reader title that does not scroll away and progress that does not pull the user's viewport. Failure and waiting states should be as understandable as success.

[Official Flighty reference collage](https://devimages-cdn.apple.com/wwdc-services/articles/images/8F09C4AC-8B30-4113-B492-E9499D512777/2048.jpeg).

### Gentler Streak: explain the data before displaying every metric

[Apple's 2024 award description](https://developer.apple.com/design/awards/2024/) highlights organized health data, a restrained design language and a monthly view oriented around progress. Adapt the hierarchy: session status first, optional model/context/cost details in a named destination. This is a presentation principle, not a recommendation to invent progress percentages for an agent.

### Notion: give mixed content a consistent structure

[Notion's writing documentation](https://www.notion.com/help/writing-and-editing-basics) describes headings, lists, tables, toggles and other block types. Its [formatting documentation](https://www.notion.com/help/columns-headings-and-dividers) describes tables and narrow-device column adaptation. Openbuff should use common summary/preview/inspect actions while retaining content-specific rendering. A narrow table needs explicit row details or horizontal navigation, rather than missing columns.

### NBC Big Board: make complicated evidence navigable

The [award record](https://winners.webbyawards.com/2025/websites-and-mobile-sites/features-design/best-data-visualization/338330/nbc-big-board-powering-data-journalism) verifies the data-visualization recognition; [Code and Theory](https://www.codeandtheory.com/) identifies it as an election-reporting project. The CLI application is a design inference: show the conclusion alongside understandable evidence and let people drill into the relevant part. Use file/hunk lists, grouped search results and validation summaries. Specific Big Board controls were not inspected, so this reference does not prescribe their interaction mechanics.

## Supporting usability evidence

[Nielsen Norman Group's progressive disclosure guidance](https://www.nngroup.com/articles/progressive-disclosure/) supports moving less-used details to a secondary destination while retaining clear access. For this CLI, that suggests three levels:

1. **Summary:** what happened, to what, and whether it needs attention.
2. **Preview:** a bounded, useful excerpt in the conversation.
3. **Inspect:** retained content in a navigable reader.

Our proposal adds truthful availability, keyboard ownership and semantic position restoration because terminal streaming creates constraints beyond ordinary document disclosure.

## Synthesis into the proposed interface

| User need | Proposed design | Strongest references |
| --- | --- | --- |
| Understand a run quickly | Outcome-first summary, visible failure state, quiet secondary metadata | Flighty, Gentler Streak |
| Keep the conversation clean | Consistent summary and bounded preview | Things, Notion |
| Read a long answer or log | Focused reader with persistent context and readable content width | Bear, Things |
| Reach a complicated detail | Heading/file/hunk/field outline and scoped find | Bear, Notion |
| Compare complex evidence | Grouped file results, row details and validation summaries | NBC Big Board, Notion |
| Work in small terminal splits | One content viewport, outline picker, responsive details | Things Slim Mode, Notion narrow layouts |

## Research limits

- Sources consulted include Apple Developer/Newsroom, the Webby award records, product documentation from Cultured Code, Bear and Notion, Code and Theory, and NN/g.
- Awwwards was also searched; selected direct pages timed out or were inaccessible and an indexed book could not be opened as a PDF. Unverified award claims from those results are not part of the reference set.
- Product pages and published interaction descriptions were reviewed. Reference images are linked above; no instrumented interaction sessions or pixel comparison were performed.
- No claim that a particular palette, animation or layout caused an award or will win an award for Openbuff.
- Live CLI captures, terminal accessibility checks and task testing are implementation gates in PLAN.md.
