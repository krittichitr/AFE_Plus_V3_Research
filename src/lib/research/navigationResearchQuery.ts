/** Forward only the explicit opt-in used by the navigation research gate. */
export function m2ResearchQuerySuffix(value: string | string[] | undefined): string {
  return value === '1' ? '&m2_research=1' : '';
}
