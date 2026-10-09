-- Test Company's plan, as a platform admin would set it in the console (ADR 069, 085). The
-- Hotel bundle is in, for Hotel 1.0's rooms and minibars (out of a plan unless put in);
-- Compliance, a block off unless switched on, is on. Test Solo Bar Co. has neither, so the
-- tests see both. In production: the console, the customer's Hotel and Events & compliance
-- cards.
update core.tenant
   set settings = jsonb_set(jsonb_set(settings, '{modules}',
                                      coalesce(settings -> 'modules', '{}') || '{"compliance": true}'),
                            '{bundles}', coalesce(settings -> 'bundles', '{}') || '{"hotel": true}')
 where code = 'TEST-COMPANY'
   and ((settings -> 'modules' ->> 'compliance') is distinct from 'true'
        or (settings -> 'bundles' ->> 'hotel') is distinct from 'true');
