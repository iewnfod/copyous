import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { registerClass } from '../common/gjs.js';
import {
	get_first_visible_child,
	get_last_visible_child,
	get_next_visible_sibling,
	get_previous_visible_sibling,
} from '../misc/actor.js';
import { ClipboardItem } from './items/clipboardItem.js';
import { State, StatusItem } from './items/statusItem.js';
import { SearchChange, SearchQuery } from './searchEntry.js';

@registerClass()
export class ClipboardScrollContainer extends St.BoxLayout {
	/** Number of items mounted when the dialog opens; the rest is filled in by idle chunks. */
	private static readonly INITIAL_MOUNT_COUNT = 24;
	/** Items mounted per idle frame while filling in the list. */
	private static readonly MOUNT_CHUNK = 32;

	private readonly _statusItem: StatusItem;
	private _lastFocus: Clutter.Actor | null = null;
	private _lastQuery: SearchQuery | null = null;

	/** All items in display order (source of truth). */
	private readonly _allItems: ClipboardItem[] = [];
	/** Items [0, _mountedCount) of _allItems are currently added as children. */
	private _mountedCount: number = 0;
	/** Incremented to cancel pending idle mount loops. */
	private _mountGeneration: number = 0;

	constructor(ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._statusItem = new StatusItem(ext);
		this.updateVisible();
	}

	private updateVisible() {
		let visibleCount = 0;
		for (const item of this._allItems) {
			if (item.visible) visibleCount++;
		}

		if (visibleCount === 0) {
			if (this._statusItem.get_parent() !== this) this.add_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.CENTER;
			this.x_expand = true;

			if (this._allItems.length === 0) {
				this._statusItem.state = State.Empty;
			} else {
				this._statusItem.state = State.NoResults;
			}
		} else if (visibleCount >= 2 && this._statusItem.get_parent() !== null) {
			this.remove_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.START;
			this.x_expand = false;
		}

		this.updatePseudoclasses();
	}

	private removePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('last-child');
	}

	private updatePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('last-child');
	}

	private nextFocus(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		if (newFocus && newFocus !== this._statusItem) {
			this.focusChild(newFocus, animate);
		} else {
			// Navigate to the search entry
			global.focus_manager.get_group(this).grab_key_focus();
		}
	}

	public focusChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		this._lastFocus = child;
		child.grab_key_focus();
		this.scrollToChild(child, animate);
	}

	public scrollToFocus(animate: boolean = true): void {
		for (const child of this.get_children()) {
			if (child.has_key_focus()) {
				this._lastFocus = child;
				this.scrollToChild(child, animate);
				return;
			}
		}
	}

	public scrollToChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const box = child.get_allocation_box();
		let adjustment: St.Adjustment;
		let value: number;
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			adjustment = this.hadjustment;
			value = box.x1 + box.get_width() * 0.5 - adjustment.page_size * 0.5;
		} else {
			adjustment = this.vadjustment;
			value = box.y1 + box.get_height() * 0.5 - adjustment.page_size * 0.5;
		}

		if (this.text_direction === Clutter.TextDirection.RTL) {
			value = adjustment.get_upper() - adjustment.page_size - value;
		}

		if (animate) {
			adjustment.ease(value, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
		} else {
			adjustment.value = value;
		}
	}

	public addItem(item: ClipboardItem): void {
		this.insertOrMoveItem(item);

		// Move item when datetime changes
		item.entry.connect('notify::datetime', () => this.insertOrMoveItem(item, false));

		// Delete item when deleted
		item.entry.connect('delete', () => this.removeItem(item));

		// Update search only when properties used by search can change.
		item.entry.connect('notify::content', () => this.updateSearch(item));
		item.entry.connect('notify::pinned', () => this.updateSearch(item));
		item.entry.connect('notify::tag', () => this.updateSearch(item));
		item.entry.connect('notify::type', () => this.updateSearch(item));
		item.entry.connect('notify::metadata', () => this.updateSearch(item));
		item.entry.connect('notify::title', () => this.updateSearch(item));
	}

	/**
	 * Unmounts all but the first few items so that opening the dialog only
	 * has to map a small prefix of the history instead of every item at once.
	 */
	public resetToInitialMount(): void {
		this._mountGeneration++;
		this.unmountTo(Math.min(ClipboardScrollContainer.INITIAL_MOUNT_COUNT, this._allItems.length));
	}

	/**
	 * Schedules mounting the remaining items in idle chunks so that the list
	 * fills in without blocking the frame that opened the dialog.
	 */
	public scheduleMountAll(): void {
		const generation = ++this._mountGeneration;

		GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			if (generation !== this._mountGeneration) return GLib.SOURCE_REMOVE;

			this.mountChunk(ClipboardScrollContainer.MOUNT_CHUNK);
			return this._mountedCount < this._allItems.length ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
		});
	}

	/**
	 * Synchronously mounts all remaining items. Used before operations that
	 * need the complete list (searching, indexed selection).
	 */
	public mountAll(): void {
		if (this._mountedCount >= this._allItems.length) return;

		this._mountGeneration++;
		while (this._mountedCount < this._allItems.length) {
			this.add_child(this._allItems[this._mountedCount]!);
			this._mountedCount++;
		}
		this.updateVisible();
	}

	/**
	 * Mounts the next chunk of items, used when the user scrolls towards the
	 * end of the currently mounted range before the idle fill-in completed.
	 */
	public mountAhead(): void {
		if (this._mountedCount >= this._allItems.length) return;

		this.mountChunk(ClipboardScrollContainer.MOUNT_CHUNK * 2);
	}

	private mountChunk(count: number): void {
		let mounted = false;
		for (let i = 0; i < count && this._mountedCount < this._allItems.length; i++) {
			this.add_child(this._allItems[this._mountedCount]!);
			this._mountedCount++;
			mounted = true;
		}
		if (mounted) this.updateVisible();
	}

	private unmountTo(count: number): void {
		let unmounted = false;
		while (this._mountedCount > count) {
			this._mountedCount--;
			this.remove_child(this._allItems[this._mountedCount]!);
			unmounted = true;
		}
		if (unmounted) this.updateVisible();
	}

	private insertOrMoveItem(item: ClipboardItem, search: boolean = true): void {
		this.removePseudoclasses();

		// Remove from the ordered list first (and from the stage if mounted)
		const prevIndex = this._allItems.indexOf(item);
		if (prevIndex >= 0) {
			this._allItems.splice(prevIndex, 1);
			if (prevIndex < this._mountedCount) {
				this.remove_child(item);
				this._mountedCount--;
			}
		}

		// Items are ordered newest first (datetime descending): binary search
		// for the first item that is not newer than the inserted one
		let lo = 0;
		let hi = this._allItems.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this._allItems[mid]!.entry.datetime.compare(item.entry.datetime) > 0) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}

		this._allItems.splice(lo, 0, item);

		// Mount the item when it lands inside the currently mounted prefix
		if (lo < this._mountedCount) {
			this.insert_child_at_index(item, lo);
			this._mountedCount++;
		}

		if (search && this._lastQuery) {
			this.updateSearch(item);
		} else {
			this.updateVisible();
		}
	}

	public clearItems(): void {
		this._mountGeneration++;
		this._allItems.length = 0;
		this._mountedCount = 0;

		let focus = false;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				focus ||= child.has_key_focus();
				this.remove_child(child);
			}
		}
		this.updateVisible();

		if (focus) {
			// Navigate to the search entry
			global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
		}
	}

	public removeItem(child: ClipboardItem): void {
		const index = this._allItems.indexOf(child);
		if (index < 0) return;

		if (index >= this._mountedCount) {
			// Not mounted: only remove it from the list
			this._allItems.splice(index, 1);
			this.updateVisible();
			return;
		}

		const hasKeyFocus = child.has_key_focus();
		let newFocus = null;
		if (hasKeyFocus) {
			newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		}

		this._allItems.splice(index, 1);
		this.remove_child(child);
		this._mountedCount--;
		this.updateVisible();

		if (hasKeyFocus) {
			if (newFocus && newFocus !== this._statusItem) {
				this.focusChild(newFocus);
			} else {
				this._lastFocus = null;

				// Navigate to the search entry
				global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
			}
		}
	}

	public selectItem(index: number): boolean {
		this.mountAll();

		let i = 0;
		for (const item of this._allItems) {
			if (item.visible) {
				if (i === index) {
					this.focusChild(item);
					return true;
				}

				i++;
			}
		}

		return false;
	}

	public selectNextItem(): void {
		this.mountAll();

		let focusChild: ClipboardItem | null = null;

		for (const item of this._allItems) {
			if (focusChild === null && item.visible) {
				focusChild = item;
			}

			if (item.has_key_focus()) {
				this.nextFocus(item);
				return;
			}
		}

		if (focusChild !== null) {
			this.focusChild(focusChild);
		}
	}

	public search(query: SearchQuery): void {
		// Copy search query, but with SearchChange.Different to always force re-search
		this._lastQuery = query.withChange(SearchChange.Different);

		// Mounting everything is only needed while the dialog is visible; a
		// search triggered while closed (e.g. the reset on close) applies to
		// the list state directly and new items are mounted lazily
		if (this.mapped) this.mountAll();

		this.removePseudoclasses();
		let focusChild: ClipboardItem | null = null;
		let firstVisible: ClipboardItem | null = null;
		for (const item of this._allItems) {
			const hasFocus = item.has_key_focus();
			item.search(query);
			if (hasFocus) focusChild = item;
			if (item.visible && firstVisible === null) firstVisible = item;
		}
		this.updateVisible();

		if (focusChild && focusChild.visible) {
			this.focusChild(focusChild, false);
		} else if (this._lastFocus && this._lastFocus.visible && this._lastFocus.get_parent() === this) {
			this.scrollToChild(this._lastFocus, false);
		} else if (firstVisible !== null) {
			this.focusChild(firstVisible, false);
		}
	}

	private updateSearch(item: ClipboardItem): void {
		if (!this._lastQuery) return;

		const hasKeyFocus = item.has_key_focus();
		this.removePseudoclasses();
		item.search(this._lastQuery);
		this.updateVisible();
		if (hasKeyFocus && !item.visible) this.nextFocus(item, false);
	}

	public activateFirst(): void {
		this.mountAll();

		const first = get_first_visible_child(this);
		if (first instanceof St.Button) {
			first.vfunc_clicked(1);
		}
	}

	override vfunc_navigate_focus(from: Clutter.Actor | null, direction: St.DirectionType): boolean {
		// Navigation from the search entry
		if (from?.get_parent() !== this) {
			// If tab navigation is used, then focus on first or last child
			if (direction === St.DirectionType.TAB_FORWARD || direction === St.DirectionType.TAB_BACKWARD) {
				this._lastFocus = null;
				const child =
					direction === St.DirectionType.TAB_BACKWARD
						? get_last_visible_child(this)
						: get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// If the last focus is null or not visible, then focus the first visible child
			if (this._lastFocus === null || !this._lastFocus.visible || this._lastFocus.get_parent() !== this) {
				this._lastFocus = null;
				const child = get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// Navigate to the search entry
			if (!this._lastFocus) return Clutter.EVENT_PROPAGATE;

			this._lastFocus.grab_key_focus();
			this.scrollToChild(this._lastFocus);
			return Clutter.EVENT_STOP;
		}

		const first = get_first_visible_child(this);
		const last = get_last_visible_child(this);
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			// If up or shift tab navigation then focus the search entry
			if (direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore down navigation
			if (direction === St.DirectionType.DOWN) {
				return Clutter.EVENT_STOP;
			}
		} else {
			// If on the first child then focus the search entry
			if (from === first && direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// If on the last child then focus on footer
			if (from === last && direction === St.DirectionType.DOWN) {
				this._lastFocus = from;
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore left and right navigation
			if (direction === St.DirectionType.LEFT || direction === St.DirectionType.RIGHT) {
				return Clutter.EVENT_STOP;
			}
		}

		// If on first child and shift tab navigation then focus the search entry
		if (from === first && direction === St.DirectionType.TAB_BACKWARD) {
			this._lastFocus = from;
			// Navigate to the search entry
			return Clutter.EVENT_PROPAGATE;
		}

		// If on last child and tab navigation then focus the footer
		if (from === last && direction === St.DirectionType.TAB_FORWARD) {
			this._lastFocus = from;
			// Navigate to footer
			return Clutter.EVENT_PROPAGATE;
		}

		// Otherwise map navigation to tab navigation due to weird behavior for a larger number of items
		const tabDirection =
			direction === St.DirectionType.TAB_FORWARD ||
			direction === St.DirectionType.RIGHT ||
			direction === St.DirectionType.DOWN
				? St.DirectionType.TAB_FORWARD
				: St.DirectionType.TAB_BACKWARD;
		const res = super.vfunc_navigate_focus(from, tabDirection);
		this.scrollToFocus();
		return res;
	}

	override vfunc_map(): void {
		this._lastFocus = null;
		this.hadjustment.value = 0;
		this.vadjustment.value = 0;

		super.vfunc_map();
	}
}
