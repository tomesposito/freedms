import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface OAuthRow<T> {data: T; expiresAt: number; consumed?: boolean}
export interface OAuthWrite {kind: string; id: string; data: unknown; expiresAt: number}
export interface OAuthStore {
  get<T>(kind: string, id: string): Promise<OAuthRow<T> | undefined>;
  put(...rows: OAuthWrite[]): Promise<void>;
  consume(kind: string, id: string): Promise<boolean>;
}
/** Only hashes of browser handles, codes and bearer tokens are persisted. TTL is cleanup, not authorization. */
export class DynamoOAuthStore implements OAuthStore {
  constructor(private table: string, private client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {marshallOptions: {removeUndefinedValues: true}})) {}
  async get<T>(kind: string, id: string): Promise<OAuthRow<T> | undefined> {
    const {Item} = await this.client.send(new GetCommand({TableName: this.table, Key: {PK: `${kind}#${digest(id)}`}, ConsistentRead: true}));
    return Item as OAuthRow<T> | undefined;
  }
  async put(...rows: OAuthWrite[]): Promise<void> {
    await this.client.send(new TransactWriteCommand({TransactItems: rows.map(({kind, id, ...row}) => ({Put: {
      TableName: this.table, Item: {PK: `${kind}#${digest(id)}`, ...row}, ConditionExpression: 'attribute_not_exists(PK)'
    }}))}));
  }
  async consume(kind: string, id: string): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({TableName: this.table, Key: {PK: `${kind}#${digest(id)}`},
        UpdateExpression: 'SET consumed = :yes', ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(consumed) AND expiresAt > :now',
        ExpressionAttributeValues: {':yes': true, ':now': Math.floor(Date.now() / 1000)}}));
      return true;
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false; throw error; }
  }
}
