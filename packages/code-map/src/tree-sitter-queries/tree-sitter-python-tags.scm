(class_definition
  name: (identifier) @identifier)

(function_definition
  name: (identifier) @identifier)

(call
  function: (identifier) @call.identifier)

(call
  function: (attribute
    attribute: (identifier) @call.identifier))

; P3-T5 AST import-capture tier: module names only (mapped by
; importSpecifiersFromAstCaptures in import-sites.ts).
(import_from_statement
  module_name: (dotted_name) @import.specifier)

(import_from_statement
  module_name: (relative_import) @import.specifier)

(import_statement
  (dotted_name) @import.specifier)

(import_statement
  (aliased_import
    name: (dotted_name) @import.specifier))
