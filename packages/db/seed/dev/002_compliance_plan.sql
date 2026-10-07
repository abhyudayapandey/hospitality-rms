-- Compliance is out of every plan unless the platform admin puts it in (ADR 069). Test Company
-- has it, as a platform admin would set on its Bundles card; Test Solo Bar Co. doesn't, so the
-- tests see both. In production: the console, Test Company -> Bundles -> Compliance on.
update core.tenant
   set settings = jsonb_set(settings, '{bundles}',
                            coalesce(settings -> 'bundles', '{}') || '{"compliance": true}')
 where code = 'TEST-COMPANY'
   and (settings -> 'bundles' ->> 'compliance') is distinct from 'true';
