import { describe, expect, it } from 'vitest';
import { configFromContext, githubDeploySubject } from './config';

const base: Record<string, unknown> = {
  domainName: 'outletops.duckdns.org',
  alertEmail: 'ops@example.com',
  cognitoDomainPrefix: 'outlet-ops-test',
  githubRepo: 'abhyudayapandey/hospitality-rms',
  githubOwnerId: '33194509',
  githubRepoId: '1394585977',
};
const ctx =
  (over: Record<string, unknown> = {}) =>
  (key: string) =>
    ({ ...base, ...over })[key];

describe('configFromContext', () => {
  it('reads the GitHub owner and repo ids', () => {
    const c = configFromContext(ctx());
    expect(c.githubOwnerId).toBe('33194509');
    expect(c.githubRepoId).toBe('1394585977');
  });

  it('accepts numeric ids given as numbers (cdk.json context)', () => {
    const c = configFromContext(ctx({ githubOwnerId: 33194509, githubRepoId: 1394585977 }));
    expect([c.githubOwnerId, c.githubRepoId]).toEqual(['33194509', '1394585977']);
  });

  it.each([
    ['githubOwnerId', undefined, /Missing CDK context "githubOwnerId"/],
    ['githubRepoId', '', /Missing CDK context "githubRepoId"/],
    ['githubOwnerId', 'abhyudayapandey', /numeric GitHub id/],
    ['githubRepoId', '13945*', /numeric GitHub id/],
    ['githubRepo', 'hospitality-rms', /owner\/repo/],
    ['githubRepo', 'abhyudayapandey/*', /owner\/repo/],
  ])('rejects %s=%j', (key, value, error) => {
    expect(() => configFromContext(ctx({ [key]: value }))).toThrow(error);
  });
});

describe('githubDeploySubject', () => {
  it('matches the sub GitHub sends for the production environment', () => {
    expect(githubDeploySubject(configFromContext(ctx()))).toBe(
      'repo:abhyudayapandey@33194509/hospitality-rms@1394585977:environment:production',
    );
  });
});
