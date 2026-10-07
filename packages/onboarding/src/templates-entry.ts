// What the platform console uses to add an outlet from a template (package subpath
// @outlet-ops/onboarding/templates, ADR 062): the plan, the merged files and the files a
// customer starts with. It never loads the loader itself.
export * from './customer-files';
export * from './outlet-template';
export { parseCsv } from './csv';
export * from './setup-draft';
