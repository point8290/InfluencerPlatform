import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { Balance, User, Wallet } from '../src/models';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';

/**
 * The password rules are security-relevant and easy to regress silently, so
 * they are asserted rather than left to the validator's own comments.
 *
 * The length cap and the character-set restriction are load-bearing TOGETHER:
 * 64 characters of single-byte ASCII is at most 64 bytes, which keeps every
 * password inside bcrypt's 72-byte input limit. Relax either one without the
 * other and bcrypt starts silently truncating, which would mean two different
 * passwords opening the same account.
 */
describe('password policy', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  let counter = 0;
  const signup = (password: string) =>
    request(app)
      .post('/api/auth/signup')
      .send({ email: `pw-${Date.now()}-${(counter += 1)}@example.com`, password });

  const messagesOf = (body: { error?: { details?: { message: string }[] } }): string =>
    (body.error?.details ?? []).map((detail) => detail.message).join(' | ');

  describe('accepts', () => {
    it.each([
      ['the minimum length', 'abcdefgh'],
      ['the maximum length', 'a'.repeat(64)],
      ['digits and letters', 'passw0rd123'],
      ['special characters', 'P@ssw0rd!#$%^&*()_+-=[]{}|;:,.<>?'],
      ['the full allowed range', '!"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~'],
    ])('%s', async (_label, password) => {
      await signup(password).expect(201);
    });
  });

  describe('rejects', () => {
    it('a password shorter than 8 characters', async () => {
      const response = await signup('abcdefg').expect(400);
      expect(messagesOf(response.body)).toContain('8-64 characters');
    });

    it('a password longer than 64 characters', async () => {
      const response = await signup('a'.repeat(65)).expect(400);
      expect(messagesOf(response.body)).toContain('8-64 characters');
    });

    it.each([
      ['a space in the middle', 'correct horse battery'],
      ['a leading space', ' password123'],
      ['a trailing space', 'password123 '],
      ['a tab', 'password\t123'],
    ])('%s', async (_label, password) => {
      const response = await signup(password).expect(400);
      expect(messagesOf(response.body)).toContain('no spaces');
    });

    it.each([
      ['non-Latin script', 'नमस्तेनमस्तेनमस्ते'],
      ['emoji', 'password🔒🔑'],
      ['accented Latin', 'contraseña-válida'],
    ])('%s', async (_label, password) => {
      await signup(password).expect(400);
    });

    it('creates no user, wallet or balances when validation fails', async () => {
      await signup('short').expect(400);

      await expect(User.count()).resolves.toBe(0);
      await expect(Wallet.count()).resolves.toBe(0);
      await expect(Balance.count()).resolves.toBe(0);
    });
  });

  describe('login', () => {
    it('does not apply the signup policy, so tightening it cannot lock anyone out', async () => {
      const email = `legacy-${Date.now()}@example.com`;
      await request(app)
        .post('/api/auth/signup')
        .send({ email, password: 'valid-password-1' })
        .expect(201);

      // A password that would fail today's signup rules must still be *checked*
      // rather than rejected outright — policy belongs at registration, and
      // authentication only asks whether the secret matches.
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'has spaces and is wrong' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const email = `oracle-${Date.now()}@example.com`;
      await request(app)
        .post('/api/auth/signup')
        .send({ email, password: 'valid-password-1' })
        .expect(201);

      const wrongPassword = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'wrong-password-1' });

      const unknownEmail = await request(app)
        .post('/api/auth/login')
        .send({ email: `nobody-${Date.now()}@example.com`, password: 'valid-password-1' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      // Byte-identical: the endpoint must not reveal which accounts exist.
      expect(wrongPassword.body).toEqual(unknownEmail.body);
    });
  });
});
