/*
 * Copyright 2018 Dialog LLC <info@dlg.im>
 */


import { Observable, Subject, EMPTY } from 'rxjs';
import { flatMap, retry } from 'rxjs/operators';
import { dialog } from '@dlghq/dialog-api';
import Rpc from './Rpc';
import {
  UUID,
  Peer,
  User,
  Group,
  ActionEvent,
  FileLocation,
  Message,
  HistoryMessage,
  ActionGroup,
  TextContent,
  DocumentContent,
  MessageAttachment
} from './entities';
import State from './State';
import { ResponseEntities } from './internal/types';
import getFileInfo from './utils/getFileInfo';
import createImagePreview from './utils/createImagePreview';
import normalizeArray from './utils/normalizeArray';
import DeletedContent from './entities/messaging/content/DeletedContent';

type Config = {
  token: string,
  endpoints: Array<string>
};

class Bot {
  private readonly rpc: Rpc;
  private readonly ready: Promise<State>;
  public readonly updateSubject: Subject<dialog.UpdateSeqUpdate> = new Subject();

  constructor(config: Config) {
    const endpoint = config.endpoints.map((url) => new URL(url)).find(() => true);
    if (!endpoint) {
      throw new Error('Endpoints misconfigured');
    }

    this.rpc = new Rpc(endpoint);
    this.ready = this.start(config.token);
  }

  private async start(token: string) {
    const self = User.from(await this.rpc.authorize(token));
    const state = new State(self);
    const dialogs = await this.applyEntities(state, await this.rpc.loadDialogs());
    state.applyDialogs(dialogs);

    this.rpc.subscribeSeqUpdates()
      .pipe(
        retry(),
        flatMap(async (update) => {
          const missing = state.checkEntities(update);
          if (missing.length) {
            const dialogs = await this.applyEntities(
              state,
              await this.rpc.loadMissingPeers(missing)
            );
            state.applyDialogs(dialogs);
          }

          state.applyUpdate(update);

          return update;
        })
      )
      .subscribe(this.updateSubject);

    return state;
  }

  private async applyEntities<T>(state: State, responseEntities: ResponseEntities<T>): Promise<T> {
    const peerEntities = state.applyResponseEntities(responseEntities);
    const entities = await this.rpc.loadPeerEntities(peerEntities);
    state.applyEntities(entities);

    return responseEntities.payload;
  }

  /**
   * Returns self (bot) user entity.
   */
  public async getSelf(): Promise<User> {
    const state = await this.ready;
    return state.self;
  }

  /**
   * Returns user by id, if bot already seen this user before.
   */
  public async getUser(uid: number): Promise<null | User> {
    const state = await this.ready;
    return state.users.get(uid) || null;
  }

  /**
   * Returns group by id, if bot already seen this group before.
   */
  public async getGroup(gid: number): Promise<null | Group> {
    const state = await this.ready;
    return state.groups.get(gid) || null;
  }

  /**
   * Subscribes to messages stream.
   */
  public onMessage(callback: (message: Message) => Promise<void>): Observable<void> {
    return this.updateSubject
      .pipe(flatMap((update) => {
        if (update.updateMessage) {
          return callback(Message.from(update.updateMessage));
        }

        return EMPTY;
      }));
  }

  /**
   * Subscribes to messages stream.
   */
  public onAction(callback: (message: ActionEvent) => Promise<void>): Observable<void> {
    return this.updateSubject
      .pipe(flatMap((update) => {
        if (update.updateInteractiveMediaEvent) {
          return callback(ActionEvent.from(update.updateInteractiveMediaEvent));
        }

        return EMPTY;
      }));
  }

  /**
   * Sends text message.
   */
  public async sendText(
    peer: Peer,
    text: string,
    attachment?: null | MessageAttachment,
    actionOrActions?: ActionGroup | ActionGroup[]
  ): Promise<UUID> {
    const state = await this.ready;
    const outPeer = state.createOutPeer(peer);
    const content = TextContent.create(text, normalizeArray(actionOrActions));

    return this.rpc.sendMessage(outPeer, content, attachment);
  }

  /**
   * Edits text message.
   */
  public async editText(
    mid: UUID,
    text: string,
    actionOrActions?: ActionGroup | ActionGroup[]
  ): Promise<void> {
    const content = TextContent.create(text, normalizeArray(actionOrActions));

    return this.rpc.editMessage(mid, content);
  }

  /**
   * Edits text message.
   */
  public async deleteMessage(mid: UUID): Promise<void> {
    return this.rpc.editMessage(mid, DeletedContent.create());
  }

  /**
   * Sends document message.
   */
  public async sendDocument(
    peer: Peer,
    fileName: string,
    attachment?: MessageAttachment
  ): Promise<UUID> {
    const state = await this.ready;
    const outPeer = state.createOutPeer(peer);
    const fileInfo = await getFileInfo(fileName);
    const fileLocation = await this.rpc.uploadFile(fileName, fileInfo);

    const content = DocumentContent.create(
      fileInfo.name,
      fileInfo.size,
      fileInfo.mime,
      null,
      FileLocation.from(fileLocation),
      null
    );

    return this.rpc.sendMessage(outPeer, content, attachment);
  }

  /**
   * Sends image message.
   */
  public async sendImage(
    peer: Peer,
    fileName: string,
    attachment?: MessageAttachment
  ): Promise<UUID> {
    const state = await this.ready;
    const outPeer = state.createOutPeer(peer);
    const fileInfo = await getFileInfo(fileName);
    const { preview, extension } = await createImagePreview(fileName);
    const fileLocation = await this.rpc.uploadFile(fileName, fileInfo);

    const content = DocumentContent.create(
      fileInfo.name,
      fileInfo.size,
      fileInfo.mime,
      preview,
      FileLocation.from(fileLocation),
      extension
    );

    return this.rpc.sendMessage(outPeer, content, attachment);
  }

  /**
   * Retrieves file url by location.
   */
  public fetchFileUrl(fileLocation: FileLocation): Promise<string> {
    return this.rpc.fetchFileUrl(fileLocation);
  }

  /**
   * Retrieves messages by message ids.
   */
  public async fetchMessages(mids: Array<UUID>): Promise<Array<HistoryMessage>> {
    const messages = await this.applyEntities(
      await this.ready,
      await this.rpc.fetchMessages(mids)
    );

    return messages.map(HistoryMessage.from);
  }

  /**
   * Finds user by nick.
   */
  public async findUserByNick(nick: string): Promise<User | null> {
    const state = await this.ready;
    const uids = await this.applyEntities(
      state,
      await this.rpc.searchContacts(nick)
    );

    const lowerNick = nick.toLowerCase();
    for (let id of uids) {
      const user = state.users.get(id);
      if (user && user.nick && lowerNick === user.nick.toLowerCase()) {
        return user;
      }
    }

    return null;
  }
}

export default Bot;
