import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export interface MailInput {
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
}
export interface MailSender {
  configured: boolean;
  send(input: MailInput): Promise<void>;
}
export class UnconfiguredMailSender implements MailSender {
  configured = false;
  async send(_input: MailInput): Promise<void> {}
}
interface SesClient {
  send(command: SendEmailCommand): Promise<unknown>;
}
export class SesMailSender implements MailSender {
  configured = true;
  constructor(private from: string, private client: SesClient = new SESClient({})) {}
  async send(input: MailInput): Promise<void> {
    await this.client.send(new SendEmailCommand({
      Source: this.from,
      Destination: {ToAddresses: [input.to]},
      ...(input.replyTo ? {ReplyToAddresses: [input.replyTo]} : {}),
      Message: {
        Subject: {Data: input.subject, Charset: 'UTF-8'},
        Body: {Text: {Data: input.text, Charset: 'UTF-8'}}
      }
    }));
  }
}
export function mailSenderFromEnv(env: NodeJS.ProcessEnv = process.env, client?: SesClient): MailSender {
  const from = env.MAIL_FROM?.trim();
  return from ? new SesMailSender(from, client) : new UnconfiguredMailSender();
}
