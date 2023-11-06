/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CanvasAddon as CanvasAddonType } from '@xterm/addon-canvas';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import type { IMarker, Terminal as RawXtermTerminal } from '@xterm/xterm';
import { importAMDNodeModule } from 'vs/amdX';
import { $, addStandardDisposableListener, append, hide, setVisibility, show } from 'vs/base/browser/dom';
import { throttle } from 'vs/base/common/decorators';
import { DisposableStore } from 'vs/base/common/lifecycle';
import 'vs/css!./media/stickyScroll';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { TerminalCapability } from 'vs/platform/terminal/common/capabilities/capabilities';
import { ITerminalContribution, ITerminalInstance, IXtermTerminal } from 'vs/workbench/contrib/terminal/browser/terminal';
import { registerTerminalContribution } from 'vs/workbench/contrib/terminal/browser/terminalExtensions';
import { TerminalInstance } from 'vs/workbench/contrib/terminal/browser/terminalInstance';
import { TerminalWidgetManager } from 'vs/workbench/contrib/terminal/browser/widgets/widgetManager';
import { ScrollPosition } from 'vs/workbench/contrib/terminal/browser/xterm/markNavigationAddon';
import { ITerminalProcessInfo, ITerminalProcessManager } from 'vs/workbench/contrib/terminal/common/terminal';

let CanvasAddon: typeof CanvasAddonType;
let SerializeAddon: typeof SerializeAddonType;

class TerminalStickyScrollContribution extends DisposableStore implements ITerminalContribution {
	static readonly ID = 'terminal.stickyScroll';

	static get(instance: ITerminalInstance): TerminalStickyScrollContribution | null {
		return instance.getContribution<TerminalStickyScrollContribution>(TerminalStickyScrollContribution.ID);
	}

	private _xterm?: IXtermTerminal & { raw: RawXtermTerminal };
	private _element?: HTMLElement;
	private _stickyScrollOverlay?: RawXtermTerminal;

	private _currentStickyMarker?: IMarker;

	private _serializeAddon?: SerializeAddonType;
	private _canvasAddon?: CanvasAddonType;

	constructor(
		private readonly _instance: ITerminalInstance,
		processManager: ITerminalProcessManager | ITerminalProcessInfo,
		widgetManager: TerminalWidgetManager,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
	) {
		super();
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._xterm = xterm;

		this.add(xterm.raw.buffer.onBufferChange(buffer => {
			const element = this._ensureElement();
			setVisibility(buffer.type === 'normal', element);
		}));

		// TODO: Skip these when hidden
		this.add(xterm.raw.onScroll(() => this._refresh()));
		this.add(xterm.raw.onLineFeed(() => this._refresh()));
		// TODO: Disable in alt buffer

		TerminalInstance.getXtermConstructor(this._keybindingService, this._contextKeyService).then(ctor => {
			const overlay = new ctor({
				rows: 1,
				cols: xterm.raw.cols
			});
			this._stickyScrollOverlay = overlay;
			this._getSerializeAddonConstructor().then(addonCtor => {
				this._serializeAddon = new addonCtor();
				xterm.raw.loadAddon(this._serializeAddon);
			});
			// TODO: Sync every render
			if (xterm.isGpuAccelerated) {
				this._getCanvasAddonConstructor().then(addonCtor => {
					this._canvasAddon = new addonCtor();
					overlay.loadAddon(this._canvasAddon);
				});
			}
		});
	}

	@throttle(0)
	private _refresh(): void {
		if (!this._xterm?.raw?.element) {
			return;
		}
		this._currentStickyMarker = undefined;
		// TODO: Cache
		const commandDetection = this._instance.capabilities.get(TerminalCapability.CommandDetection);
		if (!commandDetection) {
			return;
		}
		const command = commandDetection.getCommandForLine(this._xterm.raw.buffer.active.viewportY);
		// TODO: Expose unified interface for fetching line content
		const marker = command && 'commandStartMarker' in command
			? command.commandStartMarker
			: command && 'marker' in command
				? command.marker
				: undefined;
		if (!marker || marker.line === -1) {
			return;
		}
		this._currentStickyMarker = marker;
		const element = this._ensureElement();
		// element.textContent = this._xterm.raw.buffer.active.getLine(marker.line)?.translateToString(true) ?? '';
		if (element.textContent === '') {
			hide(element);
		} else {
			show(element);
		}
		console.log('command!', command);

		if (this._stickyScrollOverlay) {
			this._stickyScrollOverlay.write('\x1b[H\x1b[K');
			// TODO: Serialize line instead
			// TODO: Support providing single line/range serialize addon
			const s = this._serializeAddon?.serialize({
				scrollback: this._xterm.raw.buffer.active.baseY - marker.line
			});
			if (s) {
				const content = s.substring(0, s.indexOf('\r'));

				// const content = this._xterm.raw.buffer.active.getLine(marker.line)?.translateToString(true) ?? '';
				if (content) {
					this._stickyScrollOverlay.write(content);
				}
			}
			this._syncOptions(this._stickyScrollOverlay, this._xterm.raw);
		}
	}

	private _ensureElement(): HTMLElement {
		if (!this._element) {
			this._element = document.createElement('div');
			this._element.classList.add('terminal-sticky-scroll');
			// // TODO: Safety
			this._xterm!.raw.element!.parentElement!.append(this._element);

			const hoverOverlay = $('.hover-overlay');
			this.add(addStandardDisposableListener(hoverOverlay, 'click', e => {
				if (this._xterm && this._currentStickyMarker) {
					this._xterm.scrollToLine(this._currentStickyMarker.line, ScrollPosition.Middle);
				}
			}));

			// TODO: Add to a container outside the xterm instance?
			// TODO: Remove !
			this._stickyScrollOverlay!.open(this._element);

			append(this._element, hoverOverlay);
		}

		return this._element;
	}

	private _syncOptions(target: RawXtermTerminal, copyFrom: RawXtermTerminal): void {
		const o = copyFrom.options;
		target.resize(copyFrom.cols, 1);
		target.options = {
			// TODO: Support in xterm.js?
			// cursorStyle: 'none'
			cursorInactiveStyle: 'none',
			scrollback: 0,
			logLevel: 'off',
			theme: this._xterm!.getXtermTheme(),

			documentOverride: o.documentOverride,
			fontFamily: o.fontFamily,
			fontWeight: o.fontWeight,
			fontWeightBold: o.fontWeightBold,
			fontSize: o.fontSize,
			letterSpacing: o.letterSpacing,
			lineHeight: o.lineHeight,
			drawBoldTextInBrightColors: o.drawBoldTextInBrightColors,
			minimumContrastRatio: o.minimumContrastRatio,
			tabStopWidth: o.tabStopWidth,
			overviewRulerWidth: o.overviewRulerWidth,
		};
	}


	// TODO: Share ctor
	protected async _getCanvasAddonConstructor(): Promise<typeof CanvasAddonType> {
		if (!CanvasAddon) {
			CanvasAddon = (await importAMDNodeModule<typeof import('@xterm/addon-canvas')>('@xterm/addon-canvas', 'lib/xterm-addon-canvas.js')).CanvasAddon;
		}
		return CanvasAddon;
	}

	// TODO: Share ctor
	protected async _getSerializeAddonConstructor(): Promise<typeof SerializeAddonType> {
		if (!SerializeAddon) {
			SerializeAddon = (await importAMDNodeModule<typeof import('@xterm/addon-serialize')>('@xterm/addon-serialize', 'lib/addon-serialize.js')).SerializeAddon;
		}
		return SerializeAddon;
	}
}

registerTerminalContribution(TerminalStickyScrollContribution.ID, TerminalStickyScrollContribution, true);
