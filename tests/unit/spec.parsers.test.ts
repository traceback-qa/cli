import { describe, it, expect } from 'vitest';
import { ClauseParser } from '../../src/services/spec/clause.parser.js';
import { JourneyParser } from '../../src/services/spec/journey.parser.js';
import { PolicyParser } from '../../src/services/spec/policy.parser.js';

describe('Spec Parsers', () => {
  describe('ClauseParser', () => {
    const parser = new ClauseParser();

    it('parses markdown clause with YAML frontmatter and #sacred tag', () => {
      const content = `---
id: checkout-apple-pay
title: Apple Pay Checkout Flow
sacred: true
lane: checkout
tags:
  - payments
  - #sacred
viewports:
  - mobile
  - desktop
applies:
  - web
  - ios
source: LIN-1842
---

# Apple Pay Checkout Flow

User should be able to complete purchase with one click via Apple Pay.

## Acceptance Criteria
- [ ] Apple Pay button renders on supported devices
- [ ] Submitting triggers native Apple Pay sheet
- [ ] Order confirmation page displays after payment success
`;

      const clause = parser.parseContent(content, 'qa/clauses/checkout-apple-pay.md');

      expect(clause.slug).toBe('checkout-apple-pay');
      expect(clause.title).toBe('Apple Pay Checkout Flow');
      expect(clause.sacred).toBe(true);
      expect(clause.lane).toBe('checkout');
      expect(clause.viewports).toEqual(['mobile', 'desktop']);
      expect(clause.applies).toEqual(['web', 'ios']);
      expect(clause.sourceUri).toBe('LIN-1842');
      expect(clause.acceptanceCriteria).toHaveLength(3);
      expect(clause.acceptanceCriteria[0]).toContain('Apple Pay button renders');
      expect(clause.bodyHash).toBeDefined();
      expect(clause.bodyHash.length).toBe(64); // SHA-256 hex
    });

    it('detects sacred from body hashtag #sacred if omitted in frontmatter', () => {
      const content = `# Login Flow #sacred\nUser can login with email.`;
      const clause = parser.parseContent(content);
      expect(clause.sacred).toBe(true);
      expect(clause.title).toContain('Login Flow');
    });
  });

  describe('JourneyParser', () => {
    const parser = new JourneyParser();

    it('parses YAML journey specification with steps and viewports', () => {
      const content = `id: checkout-journey
intent: User walks through checkout and places order
covers:
  - checkout-apple-pay
  - cart-summary
lane: checkout
tags:
  - p0
probes:
  - visual
  - dom
viewports:
  - desktop
  - mobile
steps:
  - goto /checkout
  - assert "Order Summary is visible"
  - click: "#apple-pay-btn"
  - wait:
      timeout_ms: 1000
  - screenshot: "order-confirmation"
`;

      const journey = parser.parseContent(content, 'qa/journeys/checkout.yaml');

      expect(journey.slug).toBe('checkout-journey');
      expect(journey.intent).toBe('User walks through checkout and places order');
      expect(journey.covers).toEqual(['checkout-apple-pay', 'cart-summary']);
      expect(journey.probes).toEqual(['visual', 'dom']);
      expect(journey.viewports).toEqual(['desktop', 'mobile']);
      expect(journey.steps).toHaveLength(5);
      expect(journey.steps[0]).toEqual({ action: 'goto', target: '/checkout' });
      expect(journey.steps[1]).toEqual({ action: 'assert', assertion: 'Order Summary is visible' });
      expect(journey.steps[2].action).toBe('click');
      expect(journey.steps[2].target).toBe('#apple-pay-btn');
    });
  });

  describe('PolicyParser', () => {
    const parser = new PolicyParser();

    it('parses policy.yaml and applies default fallbacks', () => {
      const policyYaml = `
merge:
  block_on:
    - sacred_failure
    - security_finding
heal:
  locators: true
  assertions: false
  min_confidence: 0.90
`;
      const policy = parser.parsePolicyContent(policyYaml);

      expect(policy.merge.blockOn).toEqual(['sacred_failure', 'security_finding']);
      expect(policy.merge.warnOn).toEqual(PolicyParser.DEFAULT_WARN_ON);
      expect(policy.heal.locators).toBe(true);
      expect(policy.heal.assertions).toBe(false);
      expect(policy.heal.minConfidence).toBe(0.90);
      expect(policy.override.who).toEqual(PolicyParser.DEFAULT_OVERRIDE_WHO);
    });

    it('parses surface.yaml with base URL patterns and ignore paths', () => {
      const surfaceYaml = `
name: "checkout-service"
inferred_stack: "Next.js"
base_url_patterns:
  local:
    - "http://localhost:3000"
  preview:
    - "https://*.vercel.app"
ignore_paths:
  - "node_modules/**"
  - ".next/**"
`;
      const surface = parser.parseSurfaceContent(surfaceYaml, 'checkout-service');

      expect(surface.name).toBe('checkout-service');
      expect(surface.inferredStack).toBe('Next.js');
      expect(surface.baseUrlPatterns.local).toEqual(['http://localhost:3000']);
      expect(surface.baseUrlPatterns.preview).toEqual(['https://*.vercel.app']);
      expect(surface.ignorePaths).toContain('.next/**');
    });
  });
});
