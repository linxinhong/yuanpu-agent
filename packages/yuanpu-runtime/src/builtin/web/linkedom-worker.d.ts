// LinkeDOM's portable entry has the same DOM types but lacks an exports.types entry.
declare module 'linkedom/worker' {
  export const parseHTML: typeof import('linkedom').parseHTML;
}
