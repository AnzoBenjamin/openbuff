(
  (comment)*
  .
  (function_declaration
    name: (identifier) @identifier)
)

(
  (comment)*
  .
  (method_declaration
    name: (field_identifier) @identifier)
)

(type_spec
  name: (type_identifier) @identifier)

(type_identifier) @identifier

(call_expression
  function: [
    (identifier) @call.identifier
    (parenthesized_expression (identifier) @call.identifier)
    (selector_expression field: (field_identifier) @call.identifier)
    (parenthesized_expression (selector_expression field: (field_identifier) @call.identifier))
  ])

; P3-T5 AST import-capture tier: import path literals only (mapped by
; importSpecifiersFromAstCaptures in import-sites.ts). Both the single-import
; form (path directly under import_declaration) and the block form (path
; under import_spec) are covered; block paths also match the declaration-level
; pattern (tree-sitter nested patterns match descendants), but duplicate
; captures collapse in the mapper's Set.
(import_declaration
  (interpreted_string_literal) @import.specifier)

(import_declaration
  (raw_string_literal) @import.specifier)

(import_spec
  path: (interpreted_string_literal) @import.specifier)

(import_spec
  path: (raw_string_literal) @import.specifier)
