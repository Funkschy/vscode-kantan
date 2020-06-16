import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import * as proc from 'child_process';

import { LLDBDebugSession } from './lldb';

export function activate(context: vscode.ExtensionContext) {
	const provider = new ConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('kantan', provider));

	const factory = new InlineDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('kantan', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}
}

// this method is called when your extension is deactivated
export function deactivate() { }

class ConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'kantan') {
				config.type = 'kantan';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = `${folder?.uri.path}/a.out`;
				config.args = [];
			}
		}

		if (!config.compile && !config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		if (config.compile === true) {
			let args = ['-g'].concat(config.kantanFiles);
			let compilerOut = proc.spawnSync(config.kantanPath, args, { cwd: folder?.uri.path, env: process.env });

			if (compilerOut.error) {
				return vscode.window.showInformationMessage(compilerOut.error.toString()).then(_ => {
					return undefined;	// abort launch
				});
			}

			if (compilerOut.status !== 0) {
				return vscode.window.showInformationMessage(compilerOut.output.toString()).then(_ => {
					return undefined;	// abort launch
				});
			}

			config.program = `${folder?.uri.path}/a.out`;
		}

		return config;
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new LLDBDebugSession());
	}
}