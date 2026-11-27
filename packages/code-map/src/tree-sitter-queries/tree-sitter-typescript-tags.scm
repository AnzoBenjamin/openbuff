(function_declaration name: (identifier) @identifier)
(class_declaration name: (type_identifier) @identifier)
(interface_declaration name: (type_identifier) @identifier)
(method_definition name: (property_identifier) @identifier)

(export_statement
  declaration: (function_declaration
    name: (identifier) @identifier))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @identifier)))

(export_statement
  declaration: (variable_declaration
    (variable_declarator
      name: (identifier) @identifier)))

(call_expression function: (identifier) @call.identifier)
(call_expression function: (member_expression property: (property_identifier) @call.identifier))
(new_expression constructor: (identifier) @call.identifier)

; P3-T5 AST import-capture tier: module specifiers only (mapped by
; importSpecifiersFromAstCaptures in import-sites.ts). require()/import()
; arguments are captured with their enclosing call expression so the mapper
; can keep only real require/import calls without query predicates.
(import_statement
  source: (string) @import.specifier)

(export_statement
  source: (string) @import.specifier)

(call_expression
  function: (_)
  arguments: (arguments (string))) @import.call
