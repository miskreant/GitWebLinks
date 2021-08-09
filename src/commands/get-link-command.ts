import { commands, env, MessageItem, TextEditor, Uri, window } from 'vscode';

import { LinkHandler } from '../link-handler';
import { LinkHandlerProvider } from '../link-handler-provider';
import { log } from '../log';
import { NoRemoteHeadError } from '../no-remote-head-error';
import { RepositoryFinder } from '../repository-finder';
import { STRINGS } from '../strings';
import { LinkType, Repository, RepositoryWithRemote, SelectedRange } from '../types';
import { getSelectedRange, hasRemote } from '../utilities';

/**
 * The command to get a URL from a file.
 */
export class GetLinkCommand {
    /**
     * @constructor
     * @param repositoryFinder The repository finder to use for finding repository information for a file.
     * @param handlerProvider The provider of link handlers.
     * @param options The options that control how the command behaves.
     */
    constructor(
        private readonly repositoryFinder: RepositoryFinder,
        private readonly handlerProvider: LinkHandlerProvider,
        private readonly options: GetLinkCommandOptions
    ) {}

    /**
     * Executes the commands.
     *
     * @param resource The resource that the command was invoked from.
     */
    public async execute(resource: Uri | undefined): Promise<void> {
        let editor: TextEditor | undefined;
        let info: ResourceInfo | undefined;

        log('Executing command.');

        editor = window.activeTextEditor;

        // When the command is run from a menu, the resource parameter refers
        // to the file that the menu was opened from. When the command is run
        // from the command palette or via a keyboard shortcut, there won't be a
        // resource. In those cases we will use the document in the active editor.
        if (!resource) {
            resource = editor?.document.uri;
        }

        if (resource?.scheme !== 'file') {
            log("File URI scheme is '%s'.", resource?.scheme);
            void window.showErrorMessage(STRINGS.getLinkCommand.noFileSelected);
            return;
        }

        info = await this.getResourceInfo(resource);

        if (info) {
            let selection: SelectedRange | undefined;

            if (this.options.includeSelection) {
                // We are allowed to include the selection, but we can only get the
                // selection from the active editor, so we'll only include the selection
                // if the file we are generating the link for is in the active editor.
                if (resource.toString() === editor?.document.uri.toString()) {
                    selection = getSelectedRange(editor);
                    log('Line selection: %o', selection);
                }
            }

            try {
                let link: string;

                link = await info.handler.createUrl(
                    info.repository,
                    { filePath: info.uri.fsPath, selection },
                    { type: this.options.linkType }
                );

                log('Web link created: %s', link);

                switch (this.options.action) {
                    case 'copy':
                        await env.clipboard.writeText(link);

                        void window
                            .showInformationMessage<ActionMessageItem>(
                                STRINGS.getLinkCommand.linkCopied(info.handler.name),
                                {
                                    title: STRINGS.getLinkCommand.openInBrowser,
                                    action: 'open'
                                }
                            )
                            .then((x) => this.onNotificationItemClick(x, link));

                        break;

                    case 'open':
                        openExternal(link);
                }
            } catch (ex) {
                log('Error while generating a link: %o', ex);

                if (ex instanceof NoRemoteHeadError) {
                    void window.showErrorMessage(
                        STRINGS.getLinkCommand.noRemoteHead(
                            info.repository.root,
                            info.repository.remote.name
                        )
                    );
                } else {
                    void window.showErrorMessage(STRINGS.getLinkCommand.error);
                }
            }
        }
    }

    /**
     * Gets information about a resource.
     *
     * @param resource The URI of the resource to get the info for.
     * @returns The resource information.
     */
    private async getResourceInfo(resource: Uri): Promise<ResourceInfo | undefined> {
        let repository: Repository | undefined;
        let handler: LinkHandler | undefined;

        repository = await this.repositoryFinder.findRepository(resource.fsPath);

        if (!repository) {
            log('File is not tracked by Git.');
            void window.showErrorMessage(STRINGS.getLinkCommand.notTrackedByGit(resource));
            return undefined;
        }

        if (!hasRemote(repository)) {
            log('Repository does not have a remote.');
            void window.showErrorMessage(STRINGS.getLinkCommand.noRemote(repository.root));
            return undefined;
        }

        handler = this.handlerProvider.select(repository);

        if (!handler) {
            log("No handler for remote '%s'.", repository.remote);
            void window
                .showErrorMessage<ActionMessageItem>(
                    STRINGS.getLinkCommand.noHandler(repository.remote.url),
                    {
                        title: STRINGS.getLinkCommand.openSettings,
                        action: 'settings'
                    }
                )
                .then((x) => this.onNotificationItemClick(x));
            return undefined;
        }

        return { uri: resource, repository, handler };
    }

    /**
     * Handles a button on a notification being clicked.
     *
     * @param item The item that was clicked on.
     * @param link The link that has been created.
     */
    private onNotificationItemClick(item: ActionMessageItem | undefined, link?: string): void {
        switch (item?.action) {
            case 'settings':
                void commands.executeCommand('workbench.action.openSettings', 'gitweblinks');
                break;

            case 'open':
                if (link) {
                    openExternal(link);
                }
                break;
        }
    }
}

/**
 * A wrapper around `env.openExternal()` to handle a bug in VS Code.
 *
 * @param link The link to open.
 */
function openExternal(link: string): void {
    try {
        // @ts-expect-error: VS Code seems to decode and re-encode the URI, which causes certain
        // characters to be unescaped and breaks the URL. A a hack, we can try passing a string
        // instead of a URI. If that throws an error, then we'll fall back to passing a URI.
        // https://github.com/microsoft/vscode/issues/85930
        void env.openExternal(link);
    } catch {
        void env.openExternal(Uri.parse(link));
    }
}

/**
 * Options for controling the behaviouor of the command.
 */
export interface GetLinkCommandOptions {
    /**
     * The type of link the command will prodice (`undefined` means
     * the command will use the settings to determine the link type).
     */
    linkType: LinkType | undefined;

    /**
     * Whether to include the selection region
     * from the file in the link that is generated.
     */
    includeSelection: boolean;

    /**
     * The action the command should perform.
     */
    action: 'copy' | 'open';
}

/**
 * Defines information about a resource to generate a web link for.
 */
interface ResourceInfo {
    /**
     * The URI of the resource.
     */
    uri: Uri;

    /**
     * The repository that the resource is in.
     */
    readonly repository: RepositoryWithRemote;

    /**
     * The link handler for the resource.
     */
    readonly handler: LinkHandler;
}

/**
 * Defines a message item with an associated action.
 */
interface ActionMessageItem extends MessageItem {
    /**
     * The action to perform.
     */
    action: 'settings' | 'open';
}
