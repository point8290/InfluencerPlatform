import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app';
import { OutboxEvent } from '../src/models';
import { TOPICS } from '../src/outbox/events';
import { relayBatch, type EventPublisher, type OutboundMessage } from '../src/outbox/relay';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import {
  createCampaign,
  createPendingPayment,
  createUser,
  grantCredits,
  postSignedWebhook,
} from './helpers/factories';
import { checkoutSessionEvent } from './helpers/stripeEvents';

/**
 * The outbox's contract: an event exists if and only if the change it
 * describes committed, and the relay marks a row published only after the
 * publisher acknowledged it.
 */
describe('transactional outbox', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  const eventsOfType = (eventType: string) =>
    OutboxEvent.findAll({ where: { eventType }, order: [['id', 'ASC']] });

  it('records user.registered on signup, and the token carries the role claim', async () => {
    const user = await createUser(app);

    const [event, ...rest] = await eventsOfType('user.registered');
    expect(rest).toHaveLength(0);
    expect(event!.topic).toBe(TOPICS.users);
    expect(event!.aggregateId).toBe(String(user.id));
    expect(event!.payload).toEqual({ user_id: user.id, email: user.email, role: 'member' });

    const claims = jwt.decode(user.token) as jwt.JwtPayload;
    expect(claims.role).toBe('member');
    expect(claims.sub).toBe(String(user.id));
  });

  it('records credits.purchased exactly once, however many times the webhook is delivered', async () => {
    const user = await createUser(app);
    const payment = await createPendingPayment(user.id, 'campaign', 100);
    const event = checkoutSessionEvent({
      sessionId: payment.stripeSessionId!,
      paymentId: payment.id,
      amountTotal: payment.amountPaise,
    });

    await Promise.all(Array.from({ length: 5 }, () => postSignedWebhook(app, event).expect(200)));

    const events = await eventsOfType('credits.purchased');
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe(TOPICS.payments);
    expect(events[0]!.payload).toMatchObject({
      payment_id: payment.id,
      user_id: user.id,
      currency_code: 'campaign',
      module_code: 'campaigns',
      credits: 100,
      amount_paise: payment.amountPaise,
    });
  });

  it('records campaign.created and campaign.funded with the post-spend balance', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 500);
    const campaign = await createCampaign(app, user);

    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 200 })
      .expect(200);

    const [created] = await eventsOfType('campaign.created');
    expect(created!.payload).toEqual({
      campaign_id: campaign.id,
      user_id: user.id,
      module_code: 'campaigns',
    });

    const funded = await eventsOfType('campaign.funded');
    expect(funded).toHaveLength(1);
    expect(funded[0]!.payload).toMatchObject({
      campaign_id: campaign.id,
      currency_code: 'campaign',
      module_code: 'campaigns',
      credits: 200,
      balance_after: 300,
    });
  });

  it('records nothing for a funding that is rejected and rolled back', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 100);
    const campaign = await createCampaign(app, user);

    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 101 })
      .expect(422);

    await expect(eventsOfType('campaign.funded')).resolves.toHaveLength(0);
  });

  describe('relay', () => {
    class RecordingPublisher implements EventPublisher {
      sent: OutboundMessage[] = [];
      failWith: Error | null = null;

      async publish(messages: OutboundMessage[]): Promise<void> {
        if (this.failWith !== null) throw this.failWith;
        this.sent.push(...messages);
      }
    }

    it('publishes unpublished events in order, as envelopes, and marks them published', async () => {
      const user = await createUser(app);
      await createCampaign(app, user);
      const publisher = new RecordingPublisher();

      await expect(relayBatch(publisher, 100)).resolves.toBe(2);

      expect(publisher.sent.map((m) => m.envelope.event_type)).toEqual([
        'user.registered',
        'campaign.created',
      ]);
      expect(publisher.sent[0]).toMatchObject({
        topic: TOPICS.users,
        key: String(user.id),
        envelope: { schema_version: 1, aggregate_type: 'user', producer: 'credits-wallet-backend' },
      });

      // Nothing left: a second pass publishes nothing new.
      await expect(relayBatch(publisher, 100)).resolves.toBe(0);
      expect(publisher.sent).toHaveLength(2);
      await expect(OutboxEvent.count({ where: { publishedAt: null } })).resolves.toBe(0);
    });

    it('respects the batch size', async () => {
      await createUser(app);
      await createUser(app);
      await createUser(app);
      const publisher = new RecordingPublisher();

      await expect(relayBatch(publisher, 2)).resolves.toBe(2);
      await expect(relayBatch(publisher, 2)).resolves.toBe(1);
    });

    it('leaves events unpublished and records the error when the broker fails', async () => {
      await createUser(app);
      const publisher = new RecordingPublisher();
      publisher.failWith = new Error('broker unavailable');

      await expect(relayBatch(publisher, 100)).rejects.toThrow('broker unavailable');

      const [row] = await OutboxEvent.findAll();
      expect(row!.publishedAt).toBeNull();
      expect(row!.attempts).toBe(1);
      expect(row!.lastError).toBe('broker unavailable');

      // Recovers on the next pass.
      publisher.failWith = null;
      await expect(relayBatch(publisher, 100)).resolves.toBe(1);
      const [after] = await OutboxEvent.findAll();
      expect(after!.publishedAt).not.toBeNull();
      expect(after!.attempts).toBe(2);
      expect(after!.lastError).toBeNull();
    });
  });
});
