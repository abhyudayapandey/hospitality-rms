// Writes the role and department catalogue (ADR 060) to its reference files in
// docs/onboarding/test-data. A unit test fails until they match the code.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogueReference } from '@outlet-ops/domain';

const dir = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const ref = catalogueReference();
writeFileSync(join(dir, 'PRODUCT_roles_REFERENCE.csv'), ref.roles);
writeFileSync(join(dir, 'PRODUCT_departments_REFERENCE.csv'), ref.departments);
console.log('wrote PRODUCT_roles_REFERENCE.csv and PRODUCT_departments_REFERENCE.csv');
