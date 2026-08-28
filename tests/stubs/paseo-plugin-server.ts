/**
 * Test-only stand-in for `@getpaseo/plugin/server`, whose runtime is supplied by
 * Paseo rather than node_modules. `defineRpc` is an identity function in the real
 * runtime too, so contracts keep their exact shape under test.
 */
export function defineRpc<T>(definition: T): T {
  return definition;
}

export function defineAttachmentSource<T>(definition: T): T {
  return definition;
}
