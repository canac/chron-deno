import { Database } from "https://denopkg.com/canac/AloeDB@0.9.1/mod.ts";

export interface Message {
  source: string;
  timestamp: string;
  message: string;
}

export class Mailbox {
  #db: Database<Message>;

  constructor(dataDir: string) {
    this.#db = new Database<Message>(`${dataDir}/mailbox.json`);
  }

  // Return all messages
  getAllMessages(): Promise<Message[]> {
    return this.#db.findMany({});
  }

  // Return all messages for this source
  getMessages(source: string): Promise<Message[]> {
    return this.#db.findMany({ source });
  }

  // Add a new message to this source and return it
  addMessage(source: string, message: string): Promise<Message> {
    return this.#db.insertOne({
      source,
      timestamp: new Date().toString(),
      message,
    });
  }

  // Remove all messages and return them
  clearAllMessages(): Promise<Message[]> {
    return this.#db.deleteMany({});
  }

  // Remove all the messages for this source and return them
  clearMessages(source: string): Promise<Message[]> {
    return this.#db.deleteMany({ source });
  }
}
