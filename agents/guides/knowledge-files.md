# Knowledge files

Knowledge files are your guide to the project. Knowledge files (files ending in "knowledge.md", "AGENTS.md", or "CLAUDE.md") within a directory capture knowledge about that portion of the codebase. They are another way to take notes in this "Memento"-style environment.

Knowledge files were created by previous engineers working on the codebase, and they were given these same instructions. They contain key concepts or helpful tips that are not obvious from the code. e.g., let's say I want to use a package manager aside from the default. That is hard to find in the codebase and would therefore be an appropriate piece of information to add to a knowledge file.

Each knowledge file should develop over time into a concise but rich repository of knowledge about the files within the directory, subdirectories, or the specific file it's associated with.

There is a special class of user knowledge files that are stored in the user's home directory, e.g. `~/.knowledge.md`, `~/.AGENTS.md`, or `~/.CLAUDE.md`. These files are available to be read, but you cannot edit them because they are outside of the project directory. Do not try to edit them.

When should you update a knowledge file?

- If the user gives broad advice to "always do x", that is a good candidate for updating a knowledge file with a concise rule to follow or bit of advice so you won't make the mistake again.
- If the user corrects you because they expected something different from your response, any bit of information that would help you better meet their expectations in the future is a good candidate for a knowledge file.

What to include in knowledge files:

- The mission of the project. Goals, purpose, and a high-level overview of the project.
- Explanations of how different parts of the codebase work or interact.
- Examples of how to do common tasks with a short explanation.
- Anti-examples of what should be avoided.
- Anything the user has said to do.
- Anything you can infer that the user wants you to do going forward.
- Tips and tricks.
- Style preferences for the codebase.
- Technical goals that are in progress. For example, migrations that are underway, like using the new backend service instead of the old one.
- Links to reference pages that are helpful. For example, the url of documentation for an api you are using.
- Anything else that would be helpful for you or an inexperienced coder to know

What _not_ to include in knowledge files:

- Documentation of a single file.
- Restated code or interfaces in natural language.
- Anything obvious from reading the codebase.
- Lots of detail about a minor change.
- An explanation of the code you just wrote, unless there's something very unintuitive.

Again, DO NOT include details from your recent change that are not relevant more broadly.

Guidelines for updating knowledge files:

- Be concise and focused on the most important aspects of the project.
- Integrate new knowledge into existing sections when possible.
- Avoid overemphasizing recent changes or the aspect you're currently working on. Your current change is less important than you think.
- Remove as many words as possible while keeping the meaning. Use command verbs. Use sentence fragments.
- Use markdown features to improve clarity in knowledge files: headings, coding blocks, lists, dividers and so on.

Once again: BE CONCISE!

If the user sends you the url to a page that is helpful now or could be helpful in the future (e.g. documentation for a library or api), you should always save the url in a knowledge file for future reference. Any links included in knowledge files are automatically scraped and the web page content is added to the knowledge file.
