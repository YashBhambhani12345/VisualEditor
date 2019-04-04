/*!
 * VisualEditor ContentEditable Surface class.
 *
 * @copyright 2011-2019 VisualEditor Team and others; see http://ve.mit-license.org
 */

/**
 * ContentEditable surface.
 *
 * @class
 * @extends OO.ui.Element
 * @mixins OO.EventEmitter
 *
 * @constructor
 * @param {ve.dm.Surface} model Surface model to observe
 * @param {ve.ui.Surface} ui Surface user interface
 * @param {Object} [config] Configuration options
 */
ve.ce.Surface = function VeCeSurface( model, ui, config ) {
	var surface = this;

	// Parent constructor
	ve.ce.Surface.super.call( this, config );

	// Mixin constructors
	OO.EventEmitter.call( this );

	// Properties
	this.surface = ui;
	this.model = model;
	this.documentView = new ve.ce.Document( model.getDocument(), this );
	this.attachedRoot = this.getDocument().getDocumentNode().getNodeFromOffset(
		model.getAttachedRoot().getOffset() + ( model.getAttachedRoot().isWrapped() ? 1 : 0 )
	);
	this.selection = null;
	this.readOnly = false;
	this.surfaceObserver = new ve.ce.SurfaceObserver( this );
	this.$window = $( this.getElementWindow() );
	this.$document = $( this.getElementDocument() );
	this.$attachedRootNode = this.attachedRoot.$element.addClass( 've-ce-attachedRootNode' );
	// Deprecated aliases
	this.$documentNode = this.$attachedRootNode;
	this.root = this.attachedRoot;
	// Window.getSelection returns a live singleton representing the document's selection
	this.nativeSelection = this.getElementWindow().getSelection();
	ve.fixSelectionNodes( this.nativeSelection );
	this.eventSequencer = new ve.EventSequencer( [
		'keydown', 'keypress', 'keyup',
		'compositionstart', 'compositionend',
		'input', 'mousedown'
	] );
	this.clipboard = null;
	this.clipboardId = Math.random().toString();
	this.clipboardIndex = 0;
	this.renderLocks = 0;
	this.dragging = false;
	this.relocatingSelection = null;
	this.relocatingNode = null;
	this.allowedFile = null;
	this.resizing = false;
	this.focused = false;
	this.deactivated = false;
	this.deactivatedForCopy = false;
	this.$deactivatedSelection = $( '<div>' );
	this.activeNode = null;
	this.contentBranchNodeChanged = false;
	this.selectionLink = null;
	this.delayedSequences = [];
	this.$highlightsFocused = $( '<div>' );
	this.$highlightsBlurred = $( '<div>' );
	this.$highlightsUserSelections = $( '<div>' );
	this.$highlightsUserCursors = $( '<div>' );
	this.userSelectionOverlays = {};
	this.$highlights = $( '<div>' ).append(
		this.$highlightsFocused, this.$highlightsBlurred,
		this.$highlightsUserSelections, this.$highlightsUserCursors
	);
	this.$findResults = $( '<div>' );
	this.$dropMarker = $( '<div>' ).addClass( 've-ce-surface-dropMarker oo-ui-element-hidden' );
	this.$lastDropTarget = null;
	this.lastDropPosition = null;
	this.$pasteTarget = $( '<div>' );
	this.pasting = false;
	this.copying = false;
	this.pasteSpecial = false;
	this.pointerEvents = null;
	this.focusedBlockSlug = null;
	this.focusedNode = null;
	this.activeAnnotations = [];
	// This is set on entering changeModel, then unset when leaving.
	// It is used to test whether a reflected change event is emitted.
	this.newModelSelection = null;

	// Snapshot updated at keyDown. See storeKeyDownState.
	this.keyDownState = {
		event: null,
		selectionState: null
	};

	this.cursorDirectionality = null;
	this.unicorningNode = null;
	this.setUnicorningRecursionGuard = false;
	this.cursorHolders = null;

	this.hasSelectionChangeEvents = 'onselectionchange' in this.getElementDocument();

	// Events
	// Debounce to prevent trying to draw every cursor position in history.
	this.onPositionDebounced = ve.debounce( this.onPosition.bind( this ) );
	this.connect( this, { position: this.onPositionDebounced } );
	this.model.connect( this, {
		select: 'onModelSelect',
		documentUpdate: 'onModelDocumentUpdate',
		insertionAnnotationsChange: 'onInsertionAnnotationsChange'
	} );

	if ( this.model.synchronizer ) {
		this.model.synchronizer.connect( this, {
			authorSelect: 'onSynchronizerAuthorUpdate',
			authorChange: 'onSynchronizerAuthorUpdate',
			authorDisconnect: 'onSynchronizerAuthorDisconnect',
			wrongDoc: 'onSynchronizerWrongDoc'
		} );
	}

	this.onDocumentMouseUpHandler = this.onDocumentMouseUp.bind( this );
	this.$attachedRootNode.on( {
		// Mouse events shouldn't be sequenced as the event sequencer
		// is detached on blur
		mousedown: this.onDocumentMouseDown.bind( this ),
		// mouseup is bound to the whole document on mousedown
		cut: this.onCut.bind( this ),
		copy: this.onCopy.bind( this )
	} );

	this.onWindowResizeHandler = ve.debounce( this.onWindowResize.bind( this ), 50 );
	this.$window.on( 'resize', this.onWindowResizeHandler );

	this.onDocumentFocusInOutHandler = this.onDocumentFocusInOut.bind( this );
	this.$document.on( 'focusin focusout', this.onDocumentFocusInOutHandler );

	this.debounceFocusChange = ve.debounce( this.onFocusChange.bind( this ) );
	// If the document is blurred (but still has a selection) it is
	// possible to clear the selection by clicking elsewhere without
	// triggering a focus or blur event, so listen to mousedown globally.
	this.$document.on( 'mousedown', this.debounceFocusChange );
	// It is possible that when focusin fires, the selection is not yet inside
	// the document. This happens if the selection is being moved inside itself,
	// e.g. the whole html page was previously selected, including the attachedRootNode
	// In this case the selection is not moved until mouseup. T157499
	this.$attachedRootNode.on( 'mouseup', this.debounceFocusChange );

	this.$pasteTarget.add( this.$highlights ).on( {
		cut: this.onCut.bind( this ),
		copy: this.onCopy.bind( this ),
		paste: this.onPaste.bind( this )
	} );

	this.$attachedRootNode
		.on( 'paste', this.onPaste.bind( this ) )
		.on( 'focus', 'a', function () {
			// Opera <= 12 triggers 'blur' on document node before any link is
			// focused and we don't want that
			surface.$attachedRootNode[ 0 ].focus();
		} );

	// Support: IE<=11
	// IE<=11 will fire two selection change events when moving the selection from
	// the paste target to the document. We are only interested in the last one (T133104).
	this.onDocumentSelectionChangeDebounced = ve.debounce( this.onDocumentSelectionChange.bind( this ) );
	if ( this.hasSelectionChangeEvents ) {
		this.$document.on( 'selectionchange', this.onDocumentSelectionChangeDebounced );
	} else {
		// Fake selection change events with mousemove if dragging
		this.$attachedRootNode.on( 'mousemove', function () {
			if ( surface.dragging ) {
				surface.onDocumentSelectionChangeDebounced();
			}
		} );
		// mousedown needs to run after native mousedown action has changed the selection
		this.eventSequencer.after( {
			mousedown: this.onDocumentSelectionChangeDebounced
		} );
	}

	this.$element.on( {
		dragstart: this.onDocumentDragStart.bind( this ),
		dragover: this.onDocumentDragOver.bind( this ),
		dragleave: this.onDocumentDragLeave.bind( this ),
		drop: this.onDocumentDrop.bind( this )
	} );

	// Add listeners to the eventSequencer. They won't get called until
	// eventSequencer.attach(node) has been called.
	this.eventSequencer.on( {
		keydown: this.onDocumentKeyDown.bind( this ),
		keyup: this.onDocumentKeyUp.bind( this ),
		keypress: this.onDocumentKeyPress.bind( this ),
		input: this.onDocumentInput.bind( this ),
		compositionstart: this.onDocumentCompositionStart.bind( this )
	} ).after( {
		keydown: this.afterDocumentKeyDown.bind( this )
	} );

	// Initialization
	// Support: Chrome
	// Add 'notranslate' class to prevent Chrome's translate feature from
	// completely messing up the CE DOM (T59124)
	this.$element.addClass( 've-ce-surface notranslate' );
	this.$highlights.addClass( 've-ce-surface-highlights' );
	this.$highlightsFocused.addClass( 've-ce-surface-highlights-focused' );
	this.$highlightsBlurred.addClass( 've-ce-surface-highlights-blurred' );
	this.$deactivatedSelection.addClass( 've-ce-surface-deactivatedSelection' );
	this.$highlightsUserSelections.addClass( 've-ce-surface-highlights-user-selections' );
	this.$highlightsUserCursors.addClass( 've-ce-surface-highlights-user-cursors' );
	this.$pasteTarget
		.addClass( 've-ce-surface-paste' )
		.prop( {
			tabIndex: -1,
			contentEditable: 'true'
		} );

	// Add elements to the DOM
	this.$highlights.append( this.$dropMarker );
	this.$element.append( this.$attachedRootNode, this.$pasteTarget );
	this.surface.$blockers.append( this.$highlights );
	this.surface.$selections.append( this.$deactivatedSelection );
};

/* Inheritance */

OO.inheritClass( ve.ce.Surface, OO.ui.Element );

OO.mixinClass( ve.ce.Surface, OO.EventEmitter );

/* Events */

/**
 * @event relocationStart
 */

/**
 * @event relocationEnd
 */

/**
 * @event keyup
 */

/**
 * When the surface or its contents changes position
 * (only after initialize has already been called).
 *
 * @event position
 */

/**
 * @event focus
 * Note that it's possible for a focus event to occur immediately after a blur event, if the focus
 * moves to or from a FocusableNode. In this case the surface doesn't lose focus conceptually, but
 * a pair of blur-focus events is emitted anyway.
 */

/**
 * @event blur
 * Note that it's possible for a focus event to occur immediately after a blur event, if the focus
 * moves to or from a FocusableNode. In this case the surface doesn't lose focus conceptually, but
 * a pair of blur-focus events is emitted anyway.
 */

/**
 * Surface activation state has changed (i.e. on activate or deactivate)
 *
 * @event activation
 */

/* Static properties */

/**
 * Attributes considered 'unsafe' for copy/paste
 *
 * These attributes may be dropped by the browser during copy/paste, so
 * any element containing these attributes will have them JSON encoded into
 * data-ve-attributes on copy.
 *
 * @type {string[]}
 */
ve.ce.Surface.static.unsafeAttributes = [
	// Support: Firefox
	// RDFa: Firefox ignores these
	'about',
	'content',
	'datatype',
	'property',
	'rel',
	'resource',
	'rev',
	'typeof',
	// CSS: Values are often added or modified
	'style'
];

/**
 * Values of InputEvent.inputType which map to a command
 *
 * Currently these are triggered when the user selects
 * undo/redo from the context menu in Chrome, or uses the
 * selection formatting tools on iOS.
 *
 * See https://w3c.github.io/input-events/
 *
 * Values of null will perform no action and preventDefault.
 *
 * @type {Object}
 */
ve.ce.Surface.static.inputTypeCommands = {
	historyUndo: 'undo',
	historyRedo: 'redo',
	formatBold: 'bold',
	formatItalic: 'italic',
	formatUnderline: 'underline',
	formatStrikeThrough: 'strikethrough',
	formatSuperscript: 'superscript',
	formatSubscript: 'subscript',
	formatJustifyFull: null,
	formatJustifyCenter: null,
	formatJustifyRight: null,
	formatJustifyLeft: null,
	formatIndent: 'indent',
	formatOutdent: 'outdent',
	formatRemove: 'clear',
	formatSetBlockTextDirection: null,
	formatSetInlineTextDirection: null,
	formatBackColor: null,
	formatFontColor: null,
	formatFontName: null
};

/**
 * Cursor holder template
 *
 * @static
 * @property {HTMLElement}
 */
ve.ce.Surface.static.cursorHolderTemplate =
	$( '<div>' )
		.addClass( 've-ce-cursorHolder' )
		.prop( 'contentEditable', 'true' )
		.append(
			// The image does not need a src for Firefox in spite of cursoring
			// bug https://bugzilla.mozilla.org/show_bug.cgi?id=989012 , because
			// you can cursor to ce=false blocks in Firefox (see bug
			// https://bugzilla.mozilla.org/show_bug.cgi?id=1155031 )
			$( '<img>' ).addClass( 've-ce-cursorHolder-img' )
		)
		.get( 0 );

/* Static methods */

/**
 * When pasting, browsers normalize HTML to varying degrees.
 * This hash creates a comparable string for validating clipboard contents.
 *
 * @param {jQuery} $elements Clipboard HTML
 * @param {Object} [beforePasteData] Paste information, including leftText and rightText to strip
 * @return {string} Hash
 */
ve.ce.Surface.static.getClipboardHash = function ( $elements, beforePasteData ) {
	beforePasteData = beforePasteData || {};
	return $elements.text()
		.slice(
			beforePasteData.leftText ? beforePasteData.leftText.length : 0,
			beforePasteData.rightText ? -beforePasteData.rightText.length : undefined
		)
		// Whitespace may be modified (e.g. ' ' to '&nbsp;'), so strip it all
		.replace( /\s/gm, '' );
};

/* Methods */

/**
 * Destroy the surface, removing all DOM elements.
 *
 * @method
 */
ve.ce.Surface.prototype.destroy = function () {
	var attachedRoot = this.attachedRoot;

	// Support: Firefox, iOS
	// FIXME T126041: Blur to make selection/cursor disappear (needed in Firefox
	// in some cases, and in iOS to hide the keyboard)
	if ( this.isFocused() ) {
		this.blur();
	}

	// Detach observer and event sequencer
	this.surfaceObserver.stopTimerLoop();
	this.surfaceObserver.detach();
	this.eventSequencer.detach();

	// Make document node not live
	attachedRoot.setLive( false );

	// Disconnect events
	this.model.disconnect( this );

	// Disconnect DOM events on the document
	this.$document.off( 'focusin focusout', this.onDocumentFocusInOutHandler );
	this.$document.off( 'mousedown', this.debounceFocusChange );
	if ( this.hasSelectionChangeEvents ) {
		this.$document.off( 'selectionchange', this.onDocumentSelectionChangeDebounced );
	}

	if ( this.model.synchronizer ) {
		// TODO: Move destroy to ve.dm.Surface#destroy
		this.model.synchronizer.destroy();
		this.model.synchronizer.disconnect( this );
	}

	// Disconnect DOM events on the window
	this.$window.off( 'resize', this.onWindowResizeHandler );

	// Remove DOM elements (also disconnects their events)
	this.$element.remove();
	this.$highlights.remove();
};

/**
 * Get linear model offest from a mouse event
 *
 * @param {Event} e Event
 * @return {number} Linear model offset, or -1 if coordinates are out of bounds
 */
ve.ce.Surface.prototype.getOffsetFromEventCoords = function ( e ) {
	return this.getOffsetFromCoords(
		e.pageX - this.$document.scrollLeft(),
		e.pageY - this.$document.scrollTop()
	);
};

/**
 * Get linear model offset from absolute coords
 *
 * @param {number} x X offset
 * @param {number} y Y offset
 * @return {number} Linear model offset, or -1 if coordinates are out of bounds
 */
ve.ce.Surface.prototype.getOffsetFromCoords = function ( x, y ) {
	var offset, caretPosition, range, textRange, $marker,
		doc = this.getElementDocument();

	try {
		if ( doc.caretPositionFromPoint ) {
			// Gecko
			// http://dev.w3.org/csswg/cssom-view/#extensions-to-the-document-interface
			caretPosition = document.caretPositionFromPoint( x, y );
			offset = ve.ce.getOffset( caretPosition.offsetNode, caretPosition.offset );
		} else if ( doc.caretRangeFromPoint ) {
			// Webkit
			// http://www.w3.org/TR/2009/WD-cssom-view-20090804/
			range = document.caretRangeFromPoint( x, y );
			offset = ve.ce.getOffset( range.startContainer, range.startOffset );
		} else if ( document.body.createTextRange ) {
			// Trident
			// http://msdn.microsoft.com/en-gb/library/ie/ms536632(v=vs.85).aspx
			textRange = document.body.createTextRange();
			textRange.moveToPoint( x, y );
			textRange.pasteHTML( '<span class="ve-ce-textRange-drop-marker">&nbsp;</span>' );
			// eslint-disable-next-line no-jquery/no-global-selector
			$marker = $( '.ve-ce-textRange-drop-marker' );
			offset = ve.ce.getOffset( $marker.get( 0 ), 0 );
			$marker.remove();
		}
		return offset;
	} catch ( e ) {
		// Both ve.ce.getOffset and TextRange.moveToPoint can throw out of bounds exceptions
		return -1;
	}
};

/**
 * Get selection view object
 *
 * @param {ve.dm.Selection} [selection] Optional selection model, defaults to current selection
 * @return {ve.ce.Selection} Selection view
 */
ve.ce.Surface.prototype.getSelection = function ( selection ) {
	if ( selection ) {
		// Specific selection requested, bypass cache
		return ve.ce.Selection.static.newFromModel( selection, this );
	} else if ( !this.selection ) {
		this.selection = ve.ce.Selection.static.newFromModel( this.getModel().getSelection(), this );
	}
	return this.selection;
};

/**
 * Get block directionality at selection
 *
 * @return {string} 'rtl' or 'ltr'
 */
ve.ce.Surface.prototype.getSelectionDirectionality = function () {
	return this.getSelection().getDirectionality( this.getDocument() );
};

/* Initialization */

/**
 * Initialize surface.
 *
 * This should be called after the surface has been attached to the DOM.
 *
 * @method
 */
ve.ce.Surface.prototype.initialize = function () {
	this.attachedRoot.setLive( true );
	if ( $.client.profile().layout === 'gecko' ) {
		// Turn off native object editing. This must be tried after the surface has been added to DOM.
		// This is only needed in Gecko. In other engines, these properties are off by default,
		// and turning them off again is expensive; see https://phabricator.wikimedia.org/T89928
		try {
			this.$document[ 0 ].execCommand( 'enableObjectResizing', false, false );
			this.$document[ 0 ].execCommand( 'enableInlineTableEditing', false, false );
		} catch ( e ) { /* Silently ignore */ }
	}
};

/**
 * Set the read-only state of the surface
 *
 * @param {boolean} readOnly Make surface read-only
 */
ve.ce.Surface.prototype.setReadOnly = function ( readOnly ) {
	this.readOnly = !!readOnly;
	this.$element.toggleClass( 've-ce-surface-readOnly', this.readOnly );
	// TODO: Remove this deprecated class name
	this.$element.toggleClass( 've-ce-surface-enabled', !this.readOnly );
};

/**
 * Check if the surface is read-only
 *
 * @return {boolean}
 */
ve.ce.Surface.prototype.isReadOnly = function () {
	return this.readOnly;
};

/**
 * Give focus to the surface, reapplying the model selection, or selecting the first content offset
 * if the model selection is null.
 *
 * This is used when switching between surfaces, e.g. when closing a dialog window. Calling this
 * function will also reapply the selection, even if the surface is already focused.
 */
ve.ce.Surface.prototype.focus = function () {
	var node,
		surface = this,
		selection = this.getSelection();

	if ( selection.getModel().isNull() ) {
		this.getModel().selectFirstContentOffset();
		selection = this.getSelection();
	}

	// Focus the contentEditable for text selections, or the pasteTarget for focusedNode selections
	if ( selection.isFocusedNode() ) {
		this.$pasteTarget[ 0 ].focus();
	} else if ( selection.isNativeCursor() ) {
		node = this.getDocument().getNodeAndOffset( selection.getModel().getRange().start ).node;
		$( node ).closest( '[contenteditable=true]' )[ 0 ].focus();
	}

	// If we are calling focus after replacing a node the selection may be gone
	// but onDocumentFocus won't fire so restore the selection here too.
	this.onModelSelect();
	// setTimeout: postpone until onDocumentFocus has been called
	setTimeout( function () {
		// Support: Chrome
		// In some browsers (e.g. Chrome) giving the document node focus doesn't
		// necessarily give you a selection (e.g. if the first child is a <figure>)
		// so if the surface isn't 'focused' (has no selection) give it a selection
		// manually
		// TODO: rename isFocused and other methods to something which reflects
		// the fact they actually mean "has a native selection"
		if ( !surface.isFocused() ) {
			surface.getModel().selectFirstContentOffset();
		}
	} );
	// onDocumentFocus takes care of the rest
};

/**
 * Blur the surface
 */
ve.ce.Surface.prototype.blur = function () {
	if ( this.deactivated ) {
		// Clear the model selection, so activate doesn't trigger another de-activate
		this.getModel().setNullSelection();
		this.activate();
	}
	this.removeRangesAndBlur();
	// This won't trigger focusin/focusout events, so trigger focus change manually
	this.onFocusChange();
};

/**
 * Remove all native selection ranges, and blur any active element
 *
 * This should hide all virtual keyboards when present.
 */
ve.ce.Surface.prototype.removeRangesAndBlur = function () {
	this.nativeSelection.removeAllRanges();
	// Support: IE<=11
	// While switching between editor modes, there's sometimes no activeElement.
	if ( this.getElementDocument().activeElement ) {
		// Blurring the activeElement ensures the keyboard is hidden on iOS
		this.getElementDocument().activeElement.blur();
	}
};

/**
 * Handler for focusin and focusout events. Filters events and debounces to #onFocusChange.
 *
 * @param {jQuery.Event} e focusin/out event
 */
ve.ce.Surface.prototype.onDocumentFocusInOut = function ( e ) {
	// Support: IE11
	// Filter out focusin/out events on iframes
	// IE11 emits these when the focus moves into/out of an iframed document,
	// but these events are misleading because the focus in this document didn't
	// actually move.
	if ( e.target.nodeName.toLowerCase() === 'iframe' ) {
		return;
	}
	this.debounceFocusChange();
};

/**
 * Handle global focus change.
 */
ve.ce.Surface.prototype.onFocusChange = function () {
	var hasFocus = false;

	hasFocus = OO.ui.contains(
		[
			this.$attachedRootNode[ 0 ],
			this.$pasteTarget[ 0 ],
			this.$highlights[ 0 ]
		],
		this.nativeSelection.anchorNode,
		true
	);

	if ( this.deactivated ) {
		if ( OO.ui.contains( this.$attachedRootNode[ 0 ], this.nativeSelection.anchorNode, true ) ) {
			this.onDocumentFocus();
		}
	} else {
		if ( hasFocus && !this.isFocused() ) {
			this.onDocumentFocus();
		}
		if ( !hasFocus && this.isFocused() ) {
			this.onDocumentBlur();
		}
	}
};

/**
 * Deactivate the surface, stopping the surface observer and replacing the native
 * range with a fake rendered one.
 *
 * Used by dialogs so they can take focus without losing the original document selection.
 *
 * @param {boolean} [deactivatedForCopy] Surface was deactivated by preparePasteTargetForCopy
 * @fires activation
 */
ve.ce.Surface.prototype.deactivate = function ( deactivatedForCopy ) {
	this.deactivatedForCopy = !!deactivatedForCopy;
	if ( !this.deactivated ) {
		// Disable the surface observer, there can be no observable changes
		// until the surface is activated
		this.surfaceObserver.disable();
		this.deactivated = true;
		this.checkDelayedSequences();
		// Remove ranges so the user can't accidentally type into the document,
		// and so virtual keyboards are hidden.
		this.removeRangesAndBlur();
		this.updateDeactivatedSelection();
		this.clearKeyDownState();
		this.emit( 'activation' );
	}
};

/**
 * Reactivate the surface and restore the native selection
 *
 * @fires activation
 */
ve.ce.Surface.prototype.activate = function () {
	if ( this.deactivated ) {
		this.deactivated = false;
		this.deactivatedForCopy = false;
		this.updateDeactivatedSelection();
		this.surfaceObserver.enable();
		if ( OO.ui.contains( this.$attachedRootNode[ 0 ], this.nativeSelection.anchorNode, true ) ) {
			// The selection has been placed back in the document, either by the user clicking
			// or by the closing window updating the model. Poll in case it was the user clicking.
			this.surfaceObserver.clear();
			this.surfaceObserver.pollOnce();
		} else {
			// Clear focused node so onModelSelect re-selects it if necessary
			this.focusedNode = null;
			this.onModelSelect();
		}
		this.emit( 'activation' );
	}
};

/**
 * Update the fake selection while the surface is deactivated.
 *
 * While the surface is deactivated, all calls to showModelSelection will get redirected here.
 */
ve.ce.Surface.prototype.updateDeactivatedSelection = function () {
	var rects, textColor, currentNode,
		surface = this,
		selection = this.getSelection(),
		isCollapsed = selection.getModel().isCollapsed();

	this.$deactivatedSelection.empty();

	// Check we have a deactivated surface and a native selection
	if ( this.deactivated && selection.isNativeCursor() ) {
		if ( isCollapsed ) {
			currentNode = this.getDocument().getBranchNodeFromOffset(
				selection.getModel().getCoveringRange().start
			);
			if ( currentNode ) {
				// This isn't perfect as it doesn't take into account annotations.
				textColor = currentNode.$element.css( 'color' );
			}
		}
		rects = selection.getSelectionRects();
		if ( rects ) {
			rects.forEach( function ( rect ) {
				var $rect = $( '<div>' ).css( {
					top: rect.top,
					left: rect.left,
					// Collapsed selections can have a width of 0, so expand
					width: Math.max( rect.width, 1 ),
					height: rect.height
				} );
				if ( textColor ) {
					$rect.css( 'background-color', textColor );
				}
				surface.$deactivatedSelection.append( $rect );
			} );
			this.$deactivatedSelection.toggleClass( 've-ce-surface-deactivatedSelection-collapsed', isCollapsed );
		}
	}
};

/**
 * Handle document focus events.
 *
 * This is triggered by a global focusin/focusout event noticing a selection on the document.
 *
 * @method
 * @fires focus
 */
ve.ce.Surface.prototype.onDocumentFocus = function () {
	if ( this.getModel().getSelection().isNull() ) {
		// If the document is being focused by a non-mouse/non-touch user event,
		// find the first content offset and place the cursor there.
		this.getModel().selectFirstContentOffset();
	}
	this.eventSequencer.attach( this.$element );
	this.surfaceObserver.startTimerLoop();
	this.focused = true;
	this.activate();
	this.$element.addClass( 've-ce-surface-focused' );
	this.emit( 'focus' );
};

/**
 * Handle document blur events.
 *
 * This is triggered by a global focusin/focusout event noticing no selection on the document.
 *
 * @method
 * @fires blur
 */
ve.ce.Surface.prototype.onDocumentBlur = function () {
	this.eventSequencer.detach();
	this.surfaceObserver.stopTimerLoop();
	this.surfaceObserver.pollOnce();
	this.surfaceObserver.clear();
	// Setting focused to false blocks selection change handler, so fire one last time here
	this.onDocumentSelectionChange();
	this.setDragging( false );
	this.focused = false;
	if ( this.focusedNode ) {
		this.focusedNode.setFocused( false );
		this.focusedNode = null;
	}
	this.getModel().setNullSelection();
	this.$element.removeClass( 've-ce-surface-focused' );
	this.emit( 'blur' );
};

/**
 * Check if surface is focused.
 *
 * @return {boolean} Surface is focused
 */
ve.ce.Surface.prototype.isFocused = function () {
	return this.focused;
};

/**
 * Handle document mouse down events.
 *
 * @method
 * @param {jQuery.Event} e Mouse down event
 */
ve.ce.Surface.prototype.onDocumentMouseDown = function ( e ) {
	var newFragment;
	if ( e.which !== OO.ui.MouseButtons.LEFT ) {
		return;
	}

	// Remember the mouse is down
	this.setDragging( true );

	// Bind mouseup to the whole document in case of dragging out of the surface
	this.$document.on( 'mouseup', this.onDocumentMouseUpHandler );

	this.surfaceObserver.stopTimerLoop();
	// setTimeout: In some browsers the selection doesn't change until after the event
	// so poll in the 'after' function.
	// TODO: rewrite to use EventSequencer
	setTimeout( this.afterDocumentMouseDown.bind( this, e, this.getSelection() ) );

	// Support: IE
	// Handle triple click
	// FIXME T126043: do not do triple click handling in IE, because their click counting is broken
	if ( e.originalEvent.detail >= 3 && !ve.init.platform.constructor.static.isInternetExplorer() ) {
		// Browser default behaviour for triple click won't behave as we want
		e.preventDefault();

		newFragment = this.getModel().getFragment()
			// After double-clicking in an inline slug, we'll get a selection like
			// <p><span><img />|</span></p><p>|Foo</p>. This selection spans a CBN boundary,
			// so we can't expand to the nearest CBN. To handle this case and other possible
			// cases where the selection spans a CBN boundary, collapse the selection before
			// expanding it. If the selection is entirely within the same CBN as it should be,
			// this won't change the result.
			.collapseToStart()
			// Cover the CBN we're in
			.expandLinearSelection( 'closest', ve.dm.ContentBranchNode )
			// …but that covered the entire CBN, we only want the contents
			.adjustLinearSelection( 1, -1 );
		// If something weird happened (e.g. no CBN found), newFragment will be null.
		// Don't select it in that case, because that'll blur the surface.
		if ( !newFragment.isNull() ) {
			newFragment.select();
		}
	}
};

/**
 * Deferred until after document mouse down
 *
 * @param {jQuery.Event} e Mouse down event
 * @param {ve.ce.Selection} selectionBefore Selection before the mouse event
 */
ve.ce.Surface.prototype.afterDocumentMouseDown = function ( e, selectionBefore ) {
	// TODO: guard with incRenderLock?
	this.surfaceObserver.pollOnce();
	if ( e.shiftKey ) {
		this.fixShiftClickSelect( selectionBefore );
	}
};

/**
 * Handle document mouse up events.
 *
 * @method
 * @param {jQuery.Event} e Mouse up event
 */
ve.ce.Surface.prototype.onDocumentMouseUp = function ( e ) {
	this.$document.off( 'mouseup', this.onDocumentMouseUpHandler );
	this.surfaceObserver.startTimerLoop();
	// setTimeout: In some browsers the selection doesn't change until after the event
	// so poll in the 'after' function
	// TODO: rewrite to use EventSequencer
	setTimeout( this.afterDocumentMouseUp.bind( this, e, this.getSelection() ) );
};

/**
 * Deferred until after document mouse up
 *
 * @param {jQuery.Event} e Mouse up event
 * @param {ve.ce.Selection} selectionBefore Selection before the mouse event
 */
ve.ce.Surface.prototype.afterDocumentMouseUp = function ( e, selectionBefore ) {
	// TODO: guard with incRenderLock?
	this.surfaceObserver.pollOnce();
	if ( e.shiftKey ) {
		this.fixShiftClickSelect( selectionBefore );
	}
	this.setDragging( false );
};

/**
 * Fix shift-click selection
 *
 * Support: Chrome
 * When shift-clicking on links Chrome tries to collapse the selection
 * so check for this and fix manually.
 *
 * This can occur on mousedown or, if the existing selection covers the
 * link, on mouseup.
 *
 * https://code.google.com/p/chromium/issues/detail?id=345745
 *
 * @param {ve.ce.Selection} selectionBefore Selection before the mouse event
 */
ve.ce.Surface.prototype.fixShiftClickSelect = function ( selectionBefore ) {
	var newSelection;
	if ( !selectionBefore.isNativeCursor() ) {
		return;
	}
	newSelection = this.getSelection();
	if ( newSelection.getModel().isCollapsed() && !newSelection.equals( selectionBefore ) ) {
		this.getModel().setLinearSelection(
			new ve.Range(
				selectionBefore.getModel().getRange().from,
				newSelection.getModel().getRange().to
			)
		);
	}
};

/**
 * Set a flag when the user is dragging a selection
 *
 * @param {boolean} dragging Dragging (mouse is down)
 */
ve.ce.Surface.prototype.setDragging = function ( dragging ) {
	this.dragging = !!dragging;
	// Class can be used to suppress hover states, such as branch slugs.
	this.$element.toggleClass( 've-ce-surface-dragging', this.dragging );
};

/**
 * Handle document selection change events.
 *
 * @method
 * @param {jQuery.Event} e Selection change event
 */
ve.ce.Surface.prototype.onDocumentSelectionChange = function () {
	// selectionChange events are only emitted from window.document, so ignore
	// any events which are fired when the document is blurred or deactivated.
	if ( !this.focused || this.deactivated ) {
		return;
	}
	this.fixupCursorPosition( 0, this.dragging );
	this.updateActiveAnnotations();
	this.surfaceObserver.pollOnceSelection();
};

/**
 * Handle document drag start events.
 *
 * @method
 * @param {jQuery.Event} e Drag start event
 * @fires relocationStart
 */
ve.ce.Surface.prototype.onDocumentDragStart = function ( e ) {
	this.onCopy( e );
	this.startRelocation();
};

/**
 * Handle document drag over events.
 *
 * @method
 * @param {jQuery.Event} e Drag over event
 */
ve.ce.Surface.prototype.onDocumentDragOver = function ( e ) {
	var i, l, $target, $dropTarget, node, dropPosition, targetPosition, targetOffset, top, left,
		nodeType, item, fakeItem,
		dataTransferHandlerFactory = this.getSurface().dataTransferHandlerFactory,
		isContent = true,
		dataTransfer = e.originalEvent.dataTransfer;

	if ( this.relocatingNode ) {
		isContent = this.relocatingNode.isContent();
		nodeType = this.relocatingNode.getType();
	} else {
		if ( this.allowedFile === null ) {
			this.allowedFile = false;
			// If we can get file metadata, check if there is a DataTransferHandler registered
			// to handle it.
			if ( dataTransfer.items ) {
				for ( i = 0, l = dataTransfer.items.length; i < l; i++ ) {
					item = dataTransfer.items[ i ];
					if ( item.kind !== 'string' ) {
						fakeItem = new ve.ui.DataTransferItem( item.kind, item.type );
						if ( dataTransferHandlerFactory.getHandlerNameForItem( fakeItem ) ) {
							this.allowedFile = true;
							break;
						}
					}
				}
			} else if ( dataTransfer.files ) {
				for ( i = 0, l = dataTransfer.files.length; i < l; i++ ) {
					item = dataTransfer.items[ i ];
					fakeItem = new ve.ui.DataTransferItem( item.kind, item.type );
					if ( dataTransferHandlerFactory.getHandlerNameForItem( fakeItem ) ) {
						this.allowedFile = true;
						break;
					}
				}
			} else if ( Array.prototype.indexOf.call( dataTransfer.types || [], 'Files' ) !== -1 ) {
				// Support: Firefox
				// If we have no metadata (e.g. in Firefox) assume it is droppable
				this.allowedFile = true;
			}
		}
		// this.allowedFile is cached until the next dragleave event
		if ( this.allowedFile ) {
			isContent = false;
			nodeType = 'alienBlock';
		}
	}

	function getNearestDropTarget( node ) {
		while ( node.parent && !node.parent.isAllowedChildNodeType( nodeType ) ) {
			node = node.parent;
		}
		if ( node.parent ) {
			node.parent.traverseUpstream( function ( n ) {
				if ( n.shouldIgnoreChildren() ) {
					node = null;
					return false;
				}
			} );
			return node;
		}
	}

	if ( !isContent ) {
		e.preventDefault();
		$target = $( e.target ).closest( '.ve-ce-branchNode, .ve-ce-leafNode' );
		if ( $target.length ) {
			// Find the nearest node which will accept this node type
			node = getNearestDropTarget( $target.data( 'view' ) );
			if ( node ) {
				$dropTarget = node.$element;
				dropPosition = e.originalEvent.pageY - $dropTarget.offset().top > $dropTarget.outerHeight() / 2 ? 'bottom' : 'top';
			} else {
				targetOffset = this.getOffsetFromEventCoords( e.originalEvent );
				if ( targetOffset !== -1 ) {
					node = getNearestDropTarget( this.getDocument().getBranchNodeFromOffset( targetOffset ) );
					if ( node ) {
						$dropTarget = node.$element;
						dropPosition = 'top';
					}
				}
				if ( !$dropTarget ) {
					$dropTarget = this.$lastDropTarget;
					dropPosition = this.lastDropPosition;
				}
			}
		}
		if ( this.$lastDropTarget && (
			!this.$lastDropTarget.is( $dropTarget ) || dropPosition !== this.lastDropPosition
		) ) {
			this.$dropMarker.addClass( 'oo-ui-element-hidden' );
			$dropTarget = null;
		}
		if ( $dropTarget && (
			!$dropTarget.is( this.$lastDropTarget ) || dropPosition !== this.lastDropPosition
		) ) {
			targetPosition = $dropTarget.position();
			// Go beyond margins as they can overlap
			top = targetPosition.top + parseFloat( $dropTarget.css( 'margin-top' ) );
			left = targetPosition.left + parseFloat( $dropTarget.css( 'margin-left' ) );
			if ( dropPosition === 'bottom' ) {
				top += $dropTarget.outerHeight();
			}
			this.$dropMarker
				.css( {
					top: top,
					left: left
				} )
				.width( $dropTarget.outerWidth() )
				.removeClass( 'oo-ui-element-hidden' );
		}
		if ( $dropTarget !== undefined ) {
			this.$lastDropTarget = $dropTarget;
			this.lastDropPosition = dropPosition;
		}
	}
};

/**
 * Handle document drag leave events.
 *
 * @method
 * @param {jQuery.Event} e Drag leave event
 */
ve.ce.Surface.prototype.onDocumentDragLeave = function () {
	this.allowedFile = null;
	if ( this.$lastDropTarget ) {
		this.$dropMarker.addClass( 'oo-ui-element-hidden' );
		this.$lastDropTarget = null;
		this.lastDropPosition = null;
	}
};

/**
 * Handle document drop events.
 *
 * Limits native drag and drop behaviour.
 *
 * @method
 * @param {jQuery.Event} e Drop event
 * @fires relocationEnd
 */
ve.ce.Surface.prototype.onDocumentDrop = function ( e ) {
	// Properties may be nullified by other events, so cache before setTimeout
	var originFragment, originData,
		targetRange, targetOffset, targetFragment,
		targetViewNode, isMultiline, slice, linearData,
		surfaceModel = this.getModel(),
		dataTransfer = e.originalEvent.dataTransfer,
		$dropTarget = this.$lastDropTarget,
		dropPosition = this.lastDropPosition,
		platformKey = ve.getSystemPlatform() === 'mac' ? 'mac' : 'pc';

	// Prevent native drop event from modifying view
	e.preventDefault();

	if ( this.readOnly ) {
		return;
	}

	// Determine drop position
	if ( $dropTarget ) {
		// Block level drag and drop: use the lastDropTarget to get the targetOffset
		if ( $dropTarget ) {
			targetRange = $dropTarget.data( 'view' ).getModel().getOuterRange();
			if ( dropPosition === 'top' ) {
				targetOffset = targetRange.start;
			} else {
				targetOffset = targetRange.end;
			}
		} else {
			return;
		}
	} else {
		targetOffset = this.getOffsetFromEventCoords( e.originalEvent );
		if ( targetOffset === -1 ) {
			return;
		}
	}
	targetFragment = surfaceModel.getLinearFragment( new ve.Range( targetOffset ) );

	targetViewNode = this.getDocument().getBranchNodeFromOffset(
		targetFragment.getSelection().getCoveringRange().from
	);
	// TODO: Support sanitized drop on a single line node (removing line breaks)
	isMultiline = targetViewNode.isMultiline();

	// Internal drop
	if ( this.relocatingSelection ) {
		// Get a fragment and data of the node being dragged
		originFragment = surfaceModel.getFragment( this.relocatingSelection );
		if ( !isMultiline ) {
			// Data needs to be balanced to be sanitized
			slice = this.model.documentModel.shallowCloneFromRange( originFragment.getSelection().getCoveringRange() );
			linearData = new ve.dm.ElementLinearData(
				originFragment.getDocument().getStore(),
				slice.getBalancedData()
			);
			linearData.sanitize( { singleLine: true } );
			originData = linearData.data;
			// Unwrap CBN
			if ( originData[ 0 ].type && ve.dm.nodeFactory.canNodeContainContent( originData[ 0 ].type ) ) {
				originData = originData.slice( 1, originData.length - 1 );
			}
		} else {
			originData = originFragment.getData();
		}

		// Start staging so we can abort in the catch later
		surfaceModel.pushStaging();

		// Dragging performs cut-and-paste by default (remove content from old location).
		// If Ctrl on PC, or Opt (alt) on Mac, is held, it performs copy-and-paste instead.
		if ( ( platformKey === 'pc' && !e.ctrlKey ) || ( platformKey === 'mac' && !e.altKey ) ) {
			originFragment.removeContent();
		}

		try {
			// Re-insert data at new location
			targetFragment.insertContent( originData );
			surfaceModel.applyStaging();
		} catch ( error ) {
			// Insert content may throw an exception if it can't find a way
			// to fixup the insertion sensibly
			surfaceModel.popStaging();
		}

	} else {
		// External drop
		// TODO: Support sanitized external drop into single line contexts
		if ( isMultiline ) {
			this.handleDataTransfer( dataTransfer, false, targetFragment );
		}
	}
	this.endRelocation();
};

/**
 * Handle document key down events.
 *
 * @method
 * @param {jQuery.Event} e Key down event
 */
ve.ce.Surface.prototype.onDocumentKeyDown = function ( e ) {
	var trigger, executed,
		selection = this.getModel().getSelection(),
		updateFromModel = false;

	if ( selection.isNull() ) {
		return;
	}

	if ( e.which === 229 ) {
		// Support: IE, Chrome
		// Ignore fake IME events (emitted in IE and Chrome)
		return;
	}

	this.surfaceObserver.stopTimerLoop();
	this.incRenderLock();
	try {
		// TODO: is this correct?
		this.surfaceObserver.pollOnce();
	} finally {
		this.decRenderLock();
	}

	this.storeKeyDownState( e );

	if ( ve.ce.keyDownHandlerFactory.executeHandlersForKey( e.keyCode, selection.getName(), this, e ) ) {
		updateFromModel = true;
	} else {
		trigger = new ve.ui.Trigger( e );
		if ( trigger.isComplete() ) {
			executed = this.surface.execute( trigger );
			if ( executed || this.isBlockedTrigger( trigger ) ) {
				e.preventDefault();
				e.stopPropagation();
				updateFromModel = true;
			}
		}
	}

	if (
		this.readOnly && !(
			// Allowed keystrokes in readonly mode:
			// Arrows, simple navigation
			ve.ce.LinearArrowKeyDownHandler.static.keys.indexOf( e.keyCode ) !== -1 ||
			// Potential commands:
			// Function keys...
			( e.keyCode >= 112 && e.keyCode <= 123 ) ||
			// ... or anything modified (e.g. copy / select-all), excluding shift
			e.metaKey || e.ctrlKey || e.altKey
			// Keys already handled in keyDownHandlers above do not need to be exempt here
		)
	) {
		e.preventDefault();
		e.stopPropagation();
		return;
	}

	if ( !updateFromModel ) {
		this.incRenderLock();
	}
	try {
		this.surfaceObserver.pollOnce();
	} finally {
		if ( !updateFromModel ) {
			this.decRenderLock();
		}
	}
	this.surfaceObserver.startTimerLoop();
};

/**
 * Check if a trigger event is blocked from performing its default behaviour
 *
 * If any of these triggers can't execute on the surface, (e.g. the underline
 * command has been blacklisted), we should still preventDefault so ContentEditable
 * native commands don't occur, leaving the view out of sync with the model.
 *
 * @method
 * @param {ve.ui.Trigger} trigger Trigger to check
 * @return {boolean} Trigger should preventDefault
 */
ve.ce.Surface.prototype.isBlockedTrigger = function ( trigger ) {
	var platformKey = ve.getSystemPlatform() === 'mac' ? 'mac' : 'pc',
		blocked = {
			mac: [ 'cmd+b', 'cmd+i', 'cmd+u', 'cmd+z', 'cmd+y', 'cmd+shift+z', 'tab', 'shift+tab', 'cmd+[', 'cmd+]' ],
			pc: [ 'ctrl+b', 'ctrl+i', 'ctrl+u', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z', 'tab', 'shift+tab' ]
		};

	return blocked[ platformKey ].indexOf( trigger.toString() ) !== -1;
};

/**
 * Handle document key press events.
 *
 * @method
 * @param {jQuery.Event} e Key press event
 */
ve.ce.Surface.prototype.onDocumentKeyPress = function ( e ) {
	var selection;

	// Handle the case where keyPress Enter is fired without a matching keyDown. This can
	// happen with OS X Romanising Korean IMEs on Firefox, when pressing Enter with
	// uncommitted candidate text; see T120156. Behave as though keyDown Enter has been
	// fired.
	if (
		e.keyCode === OO.ui.Keys.ENTER &&
		!this.keyDownState.event &&
		// We're only aware of cases of this happening with uncommitted candidate text,
		// which implies a native selection. But we instead perform a weaker test - for
		// a non-null selection - to match that same test in onDocumentKeyDown
		!( ( selection = this.getModel().getSelection() ).isNull() )
	) {
		this.surfaceObserver.stopTimerLoop();
		if ( ve.ce.keyDownHandlerFactory.executeHandlersForKey( e.keyCode, selection.getName(), this, e ) ) {
			this.surfaceObserver.pollOnce();
		}
		this.surfaceObserver.startTimerLoop();
		return;
	}

	// Filter out non-character keys. Doing this prevents:
	// * Unexpected content deletion when selection is not collapsed and the user presses, for
	//   example, the Home key (Firefox fires 'keypress' for it)
	// TODO: Should be covered with Selenium tests.
	if (
		// Catches most keys that don't produce output (charCode === 0, thus no character)
		e.which === 0 || e.charCode === 0 ||
		// Opera 12 doesn't always adhere to that convention
		e.keyCode === OO.ui.Keys.TAB || e.keyCode === OO.ui.Keys.ESCAPE ||
		// Ignore all keypresses with Ctrl / Cmd modifier keys
		ve.ce.isShortcutKey( e )
	) {
		return;
	}

	this.handleInsertion();
};

/**
 * Deferred until after document key down event
 *
 * @param {jQuery.Event} e keydown event
 */
ve.ce.Surface.prototype.afterDocumentKeyDown = function ( e ) {
	var keyDownSelectionState, direction, focusableNode, captionNode, startOffset, endOffset,
		offsetDiff, dmFocus, dmSelection, inNonSlug, ceSelection, ceNode, range,
		fixupCursorForUnicorn, matrix, col, row, $focusNode, removedUnicorns, tableNode,
		surface = this,
		documentModel = this.getModel().getDocument(),
		isArrow = (
			e.keyCode === OO.ui.Keys.UP ||
			e.keyCode === OO.ui.Keys.DOWN ||
			e.keyCode === OO.ui.Keys.LEFT ||
			e.keyCode === OO.ui.Keys.RIGHT
		);

	/**
	 * Determine whether a position is editable, and if so which focusable node it is in
	 *
	 * We can land inside ce=false in many browsers:
	 * - Firefox has normal cursor positions at most node boundaries inside ce=false
	 * - Chromium has superfluous cursor positions around a ce=false img
	 * - IE hardly restricts editing at all inside ce=false
	 * If ce=false then we have landed inside the focusable node.
	 * If we land in a non-text position, assume we should have hit the node
	 * immediately after the position we hit (in the direction of motion)
	 * If we land inside a sequence of grouped nodes, assume we should treat them as a
	 * unit instead of letting the cursor slip inside them.

	 * @private
	 * @param {Node} node DOM node of cursor position
	 * @param {number} offset Offset of cursor position
	 * @param {number} direction Cursor motion direction (1=forward, -1=backward)
	 * @return {ve.ce.Node|null} node, or null if not in a focusable node
	 */
	function getSurroundingFocusableNode( node, offset, direction ) {
		var focusNode;
		if ( node.nodeType === Node.TEXT_NODE ) {
			focusNode = node;
		} else if ( direction > 0 && offset < node.childNodes.length ) {
			focusNode = node.childNodes[ offset ];
		} else if ( direction < 0 && offset > 0 ) {
			focusNode = node.childNodes[ offset - 1 ];
		} else {
			focusNode = node;
		}

		if ( ve.isContentEditable( focusNode ) ) {
			// We are allowed to be inside this focusable node (e.g. editing a
			// table cell or caption).
			return null;
		}
		return $( focusNode ).closest( '.ve-ce-focusableNode, .ve-ce-tableNode' ).data( 'view' ) || null;
	}

	/**
	 * Compute the direction of cursor movement, if any
	 *
	 * Even if the user pressed a cursor key in the interior of the document, there may not
	 * be any movement: browser BIDI and ce=false handling can be quite quirky.
	 *
	 * Furthermore, the keydown selection nodes may have become detached since keydown (e.g.
	 * if ve.ce.ContentBranchNode#renderContents has run).
	 *
	 * @return {number|null} negative for startwards, positive for endwards, null for none
	 */
	function getDirection() {
		return (
			isArrow &&
			keyDownSelectionState &&
			ve.compareDocumentOrder(
				surface.nativeSelection.focusNode,
				surface.nativeSelection.focusOffset,
				keyDownSelectionState.focusNode,
				keyDownSelectionState.focusOffset
			)
		) || null;
	}

	if ( e !== this.keyDownState.event ) {
		return;
	}
	keyDownSelectionState = this.keyDownState.selectionState;
	this.clearKeyDownState();

	if (
		( e.keyCode === OO.ui.Keys.BACKSPACE || e.keyCode === OO.ui.Keys.DELETE ) &&
		this.nativeSelection.focusNode
	) {
		inNonSlug = this.nativeSelection.focusNode.nodeType === Node.ELEMENT_NODE &&
			!this.nativeSelection.focusNode.classList.contains( 've-ce-branchNode-inlineSlug' );
		if ( inNonSlug ) {
			// In a non-slug element. Sync the DM, then see if we need a slug.
			this.incRenderLock();
			try {
				this.surfaceObserver.pollOnce();
			} finally {
				this.decRenderLock();
			}

			dmSelection = surface.model.getSelection();
			if ( dmSelection instanceof ve.dm.LinearSelection ) {
				dmFocus = dmSelection.getRange().end;
				ceNode = this.documentView.getBranchNodeFromOffset( dmFocus );
				if ( ceNode && ceNode.getModel().hasSlugAtOffset( dmFocus ) ) {
					ceNode.setupBlockSlugs();
				}
			}
		}

		// Remove then re-set the selection, to clear any browser-native preannotations.
		// This should be IME-safe because delete/backspace key events should only happen
		// when there is no IME candidate window open.
		//
		// Note that if an IME removes text otherwise than by delete/backspace, then
		// browser-native preannotations might still get applied. This can happen: see
		// https://phabricator.wikimedia.org/T116275 .
		// That's nasty, but it's not a reason to leave the delete/backspace case broken.
		ceSelection = new ve.SelectionState( this.nativeSelection );
		this.nativeSelection.removeAllRanges();
		this.showSelectionState( ceSelection );

		if ( inNonSlug ) {
			return;
		}
	}

	// Only fixup cursoring on linear selections.
	if ( isArrow && !( surface.model.getSelection() instanceof ve.dm.LinearSelection ) ) {
		return;
	}

	// Restore the selection and stop, if we cursored out of a table edit cell.
	// Assumption: if we cursored out of a table cell, then none of the fixups below this point
	// would have got the selection back inside the cell. Therefore it's OK to check here.
	if ( isArrow && this.restoreActiveNodeSelection() ) {
		return;
	}

	// If we landed in a cursor holder, select the corresponding focusable node instead
	// (which, for a table, will select the first cell). Else if we arrowed a collapsed
	// cursor across a focusable node, select the node instead.
	$focusNode = $( this.nativeSelection.focusNode );
	if ( $focusNode.hasClass( 've-ce-cursorHolder' ) ) {
		if ( $focusNode.hasClass( 've-ce-cursorHolder-after' ) ) {
			direction = -1;
			focusableNode = $focusNode.prev().data( 'view' );
		} else {
			direction = 1;
			focusableNode = $focusNode.next().data( 'view' );
		}
		this.removeCursorHolders();
	} else if (
		// If we arrowed a collapsed cursor into/across a focusable node, select the node instead
		isArrow &&
		!e.ctrlKey &&
		!e.altKey &&
		!e.metaKey &&
		keyDownSelectionState &&
		keyDownSelectionState.isCollapsed &&
		this.nativeSelection.isCollapsed &&
		( direction = getDirection() ) !== null
	) {
		focusableNode = getSurroundingFocusableNode(
			this.nativeSelection.focusNode,
			this.nativeSelection.focusOffset,
			direction
		);

		if ( !focusableNode ) {
			// Calculate the DM offsets of our motion
			try {
				startOffset = ve.ce.getOffset(
					keyDownSelectionState.focusNode,
					keyDownSelectionState.focusOffset
				);
				endOffset = ve.ce.getOffset(
					this.nativeSelection.focusNode,
					this.nativeSelection.focusOffset
				);
				offsetDiff = endOffset - startOffset;
			} catch ( ex ) {
				startOffset = endOffset = offsetDiff = undefined;
			}

			if ( Math.abs( offsetDiff ) === 2 ) {
				// Test whether we crossed a focusable node
				// (this applies even if we cursored up/down)
				focusableNode = documentModel.documentNode
					.getNodeFromOffset( ( startOffset + endOffset ) / 2 );

				if ( focusableNode.isFocusable() ) {
					range = new ve.Range( startOffset, endOffset );
				} else {
					focusableNode = undefined;
				}
			}
		}
	}

	if (
		isArrow &&
		direction > 0 &&
		this.getActiveNode() instanceof ve.ce.TableCaptionNode &&
		this.getActiveNode() !== $focusNode.closest( '.ve-ce-tableCaptionNode' ).data( 'view' )
	) {
		// We cursored down out of the table caption; move to the first table cell
		tableNode = this.getActiveNode().getParent();
		this.model.setSelection( new ve.dm.TableSelection( tableNode.getOuterRange(), 0, 0 ) );
	}

	if ( focusableNode ) {
		if ( !range ) {
			range = focusableNode.getOuterRange();
			if ( direction < 0 ) {
				range = range.flip();
			}
		}
		if ( focusableNode instanceof ve.ce.TableNode ) {
			if ( direction > 0 ) {
				if ( ( captionNode = focusableNode.getModel().getCaptionNode() ) ) {
					this.model.setLinearSelection(
						documentModel.getRelativeRange( new ve.Range( captionNode.getRange().start ), 1 )
					);
				} else {
					this.model.setSelection( new ve.dm.TableSelection(
						range, 0, 0
					) );
				}
			} else {
				matrix = focusableNode.getModel().getMatrix();
				row = matrix.getRowCount() - 1;
				col = matrix.getColCount( row ) - 1;
				this.model.setSelection( new ve.dm.TableSelection(
					range, col, row
				) );
			}
		} else {
			this.model.setLinearSelection( range );
		}
		if ( e.keyCode === OO.ui.Keys.LEFT ) {
			this.cursorDirectionality = direction > 0 ? 'rtl' : 'ltr';
		} else if ( e.keyCode === OO.ui.Keys.RIGHT ) {
			this.cursorDirectionality = direction < 0 ? 'rtl' : 'ltr';
		}
		// else up/down pressed; leave this.cursorDirectionality as null
		// (it was set by setLinearSelection calling onModelSelect)
	}

	if ( direction === undefined ) {
		direction = getDirection();
	}

	fixupCursorForUnicorn = (
		!e.shiftKey &&
		( e.keyCode === OO.ui.Keys.LEFT || e.keyCode === OO.ui.Keys.RIGHT )
	);
	removedUnicorns = this.cleanupUnicorns( fixupCursorForUnicorn );
	if ( removedUnicorns ) {
		this.surfaceObserver.pollOnceNoCallback();
	} else {
		this.incRenderLock();
		try {
			this.surfaceObserver.pollOnce();
		} finally {
			this.decRenderLock();
		}
	}
	this.fixupCursorPosition( direction, e.shiftKey );
};

/**
 * Check whether the DOM selection has moved out of the unicorned area (i.e. is not currently
 * between two unicorns) and if so, set the model selection from the DOM selection, destroy the
 * unicorns and return true. If there are no active unicorns, this function does nothing and
 * returns false.
 *
 * If the unicorns are destroyed as a consequence of the user moving the cursor across a unicorn
 * with the left/rightarrow keys, the cursor will have to be moved again to produce the cursor
 * movement the user expected. Set the fixupCursor parameter to true to enable this behavior.
 *
 * @param {boolean} fixupCursor If destroying unicorns, fix up left/rightarrow cursor position
 * @return {boolean} Whether unicorns have been destroyed
 */
ve.ce.Surface.prototype.cleanupUnicorns = function ( fixupCursor ) {
	var preUnicorn, range, node, fixup, veRange,
		contentBranchNodeBefore, contentBranchNodeAfter;

	if ( !this.unicorningNode || !this.unicorningNode.unicorns ) {
		return false;
	}
	preUnicorn = this.unicorningNode.unicorns[ 0 ];
	if ( !this.$attachedRootNode[ 0 ].contains( preUnicorn ) ) {
		return false;
	}

	if ( this.nativeSelection.rangeCount === 0 ) {
		// XXX do we want to clear unicorns in this case?
		return false;
	}
	range = this.nativeSelection.getRangeAt( 0 );

	// Test whether the selection endpoint is between unicorns. If so, do nothing.
	// Unicorns can only contain text, so just move backwards until we hit a non-text node.
	node = range.endContainer;
	if ( node.nodeType === Node.ELEMENT_NODE ) {
		node = range.endOffset > 0 ? node.childNodes[ range.endOffset - 1 ] : null;
	}
	while ( node !== null && node.nodeType === Node.TEXT_NODE ) {
		node = node.previousSibling;
	}
	if ( node === preUnicorn ) {
		return false;
	}

	// Selection endpoint is not between unicorns.
	// Test whether it is before or after the pre-unicorn (i.e. before/after both unicorns)
	if ( ve.compareDocumentOrder(
		range.endContainer,
		range.endOffset,
		preUnicorn.parentNode,
		ve.parentIndex( preUnicorn )
	) <= 0 ) {
		// Before the pre-unicorn (including in the equality case, because the selection
		// endpoint is an offset between sibling positions)
		fixup = -1;
	} else {
		// At or after the pre-unicorn (actually must be after the post-unicorn)
		fixup = 1;
	}

	contentBranchNodeBefore = this.getSelectedContentBranchNode();

	// Apply the DOM selection to the model
	veRange = ve.ce.veRangeFromSelection( this.nativeSelection );
	if ( veRange ) {
		this.incRenderLock();
		try {
			// The most likely reason for this condition to not-pass is if we
			// try to cleanup unicorns while the native selection is outside
			// the model momentarily, as sometimes happens during paste.
			this.changeModel( null, new ve.dm.LinearSelection( veRange ) );
			if ( fixupCursor ) {
				this.moveModelCursor( fixup );
			}
		} finally {
			this.decRenderLock();
		}
	}

	contentBranchNodeAfter = this.getSelectedContentBranchNode();
	if ( contentBranchNodeAfter ) {
		contentBranchNodeAfter.renderContents();
	}
	if ( contentBranchNodeBefore && contentBranchNodeBefore !== contentBranchNodeAfter ) {
		contentBranchNodeBefore.renderContents();
	}

	this.showModelSelection();
	return true;
};

/**
 * Handle document key up events.
 *
 * @method
 * @param {jQuery.Event} e Key up event
 * @fires keyup
 */
ve.ce.Surface.prototype.onDocumentKeyUp = function () {
	this.emit( 'keyup' );
};

/**
 * Handle cut events.
 *
 * @method
 * @param {jQuery.Event} e Cut event
 */
ve.ce.Surface.prototype.onCut = function ( e ) {
	var surface = this,
		selection = this.getModel().getSelection();

	if ( selection.isCollapsed() ) {
		return;
	}

	this.onCopy( e );
	// setTimeout: postpone until after the setTimeout in onCopy
	setTimeout( function () {
		// Trigger a fake backspace to remove the content: this behaves differently based on the selection,
		// e.g. in a TableSelection.
		ve.ce.keyDownHandlerFactory.executeHandlersForKey( OO.ui.Keys.BACKSPACE, selection.getName(), surface, e );
	} );
};

/**
 * Handle copy events.
 *
 * @method
 * @param {jQuery.Event} e Copy event
 */
ve.ce.Surface.prototype.onCopy = function ( e ) {
	var originalSelection, clipboardKey, scrollTop, unsafeSelector, slice,
		isClipboard = e.type === 'copy' || e.type === 'cut',
		selection = this.getModel().getSelection(),
		view = this,
		htmlDoc = this.getModel().getDocument().getHtmlDocument(),
		clipboardData = isClipboard ? e.originalEvent.clipboardData : e.originalEvent.dataTransfer;

	this.$pasteTarget.empty();

	if ( selection.isCollapsed() ) {
		return;
	}

	slice = this.model.documentModel.shallowCloneFromSelection( selection );

	// Clone the elements in the slice
	slice.data.cloneElements( true );

	ve.dm.converter.getDomSubtreeFromModel( slice, this.$pasteTarget[ 0 ], ve.dm.Converter.static.CLIPBOARD_MODE );

	// Some browsers strip out spans when they match the styling of the
	// paste target (e.g. plain spans) so we must protect against this
	// by adding a dummy class, which we can remove after paste.
	this.$pasteTarget.find( 'span' ).addClass( 've-pasteProtect' );

	// When paste has no text content browsers do extreme normalization…
	if ( this.$pasteTarget.text() === '' ) {
		// …so put nbsp's in empty leaves
		this.$pasteTarget.find( '*:not( :has( * ) )' ).html( '&nbsp;' );
	}

	// Resolve attributes (in particular, expand 'href' and 'src' using the right base)
	ve.resolveAttributes(
		this.$pasteTarget[ 0 ],
		htmlDoc,
		ve.dm.Converter.static.computedAttributes
	);

	// Support: Firefox
	// Some attributes (e.g RDFa attributes in Firefox) aren't preserved by copy
	unsafeSelector = '[' + ve.ce.Surface.static.unsafeAttributes.join( '],[' ) + ']';
	this.$pasteTarget.find( unsafeSelector ).each( function () {
		var i, val,
			attrs = {},
			ua = ve.ce.Surface.static.unsafeAttributes;

		i = ua.length;
		while ( i-- ) {
			val = this.getAttribute( ua[ i ] );
			if ( val !== null ) {
				attrs[ ua[ i ] ] = val;
			}
		}
		this.setAttribute( 'data-ve-attributes', JSON.stringify( attrs ) );
	} );

	this.clipboardIndex++;
	clipboardKey = this.clipboardId + '-' + this.clipboardIndex;
	this.clipboard = { slice: slice, hash: null };
	// Support: IE, Firefox<48
	// Writing the key to text/xcustom won't work in IE & Firefox<48, so write
	// it to the HTML instead
	if ( isClipboard && !ve.isClipboardDataFormatsSupported( e ) ) {
		this.$pasteTarget.prepend(
			$( '<span>' ).attr( 'data-ve-clipboard-key', clipboardKey ).html( '&nbsp;' )
		);
		// To ensure the contents with the clipboardKey isn't modified in an external editor,
		// store a hash of the contents for later validation.
		this.clipboard.hash = this.constructor.static.getClipboardHash( this.$pasteTarget.contents() );
	}

	// If we have access to the clipboard write straight to it so we don't
	// have to fiddle around with the selection and fix scroll offsets.
	// Support: Edge
	// Despite having the clipboard API, Edge only supports Text and URL types.
	if ( clipboardData && !ve.init.platform.constructor.static.isEdge() ) {
		if ( isClipboard ) {
			// Disable the default event so we can override the data
			e.preventDefault();
		}

		// Only write a custom mime type if we think the browser supports it, otherwise
		// we will have already written a key to the HTML above.
		if ( isClipboard && ve.isClipboardDataFormatsSupported( e, true ) ) {
			clipboardData.setData( 'text/xcustom', clipboardKey );
		}
		try {
			// Support IE
			// This fails when dragging in IE.
			clipboardData.setData( 'text/html', this.$pasteTarget.html() );
			// innerText "approximates the text the user would get if they highlighted the
			// contents of the element with the cursor and then copied to the clipboard." - MDN
			// Use $.text as a fallback for Firefox <= 44
			clipboardData.setData( 'text/plain', this.$pasteTarget[ 0 ].innerText || this.$pasteTarget.text() || ' ' );
		} catch ( err ) {}
	} else {
		// Support: IE
		// If direct clipboard editing is not allowed, we must use the pasteTarget to
		// select the data we want to go in the clipboard
		if ( this.getSelection().isNativeCursor() ) {
			// We have a selection in the document; preserve it so it can restored
			originalSelection = new ve.SelectionState( this.nativeSelection );

			// Save scroll position before changing focus to "offscreen" paste target
			scrollTop = this.$window.scrollTop();

			// Prevent surface observation due to native range changing
			this.surfaceObserver.disable();
			ve.selectElement( this.$pasteTarget[ 0 ] );

			// Restore scroll position after changing focus
			this.$window.scrollTop( scrollTop );

			// setTimeout: postpone until after the default copy action
			setTimeout( function () {
				// If the range was in $highlights (right-click copy), don't restore it
				if ( !OO.ui.contains( view.$highlights[ 0 ], originalSelection.focusNode, true ) ) {
					// Change focus back
					view.$attachedRootNode[ 0 ].focus();
					view.showSelectionState( originalSelection );
					// Restore scroll position
					view.$window.scrollTop( scrollTop );
				}
				view.surfaceObserver.clear();
				view.surfaceObserver.enable();
			} );
		} else {
			// If the selection is non-native, the pasteTarget *should* already be selected…
			ve.selectElement( this.$pasteTarget[ 0 ] );
		}
	}

	ve.track( 'activity.clipboard', { action: e.type } );
};

/**
 * Handle native paste event
 *
 * @param {jQuery.Event} e Paste event
 * @return {boolean} False if the event is cancelled
 */
ve.ce.Surface.prototype.onPaste = function ( e ) {
	var surface = this;
	// Prevent pasting until after we are done
	if ( this.pasting || this.readOnly ) {
		return false;
	}
	this.beforePaste( e );
	this.surfaceObserver.disable();
	this.pasting = true;
	// setTimeout: postpone until after the default paste action
	setTimeout( function () {
		var afterPastePromise = ve.createDeferred().resolve().promise();
		try {
			if ( !e.isDefaultPrevented() ) {
				afterPastePromise = surface.afterPaste( e );
			}
		} finally {
			afterPastePromise.then( function () {
				surface.surfaceObserver.clear();
				surface.surfaceObserver.enable();

				// Allow pasting again
				surface.pasting = false;
				surface.pasteSpecial = false;
				surface.beforePasteData = null;

				ve.track( 'activity.clipboard', { action: 'paste' } );
			} );
		}
	} );
};

/**
 * Handle pre-paste events.
 *
 * @param {jQuery.Event} e Paste event
 */
ve.ce.Surface.prototype.beforePaste = function ( e ) {
	var range, startNode, endNode, contextElement, nativeRange,
		context, leftText, rightText, textNode, textStart, textEnd,
		selection = this.getModel().getSelection(),
		clipboardData = e.originalEvent.clipboardData,
		surfaceModel = this.getModel(),
		fragment = surfaceModel.getFragment(),
		documentModel = surfaceModel.getDocument();

	if ( selection instanceof ve.dm.LinearSelection ) {
		range = fragment.getSelection().getRange();
	} else if ( selection instanceof ve.dm.TableSelection ) {
		range = new ve.Range( selection.getRanges( documentModel )[ 0 ].start );
	} else {
		e.preventDefault();
		return;
	}

	this.beforePasteData = {};
	if ( clipboardData ) {
		if ( this.handleDataTransfer( clipboardData, true ) ) {
			e.preventDefault();
			return;
		}
		this.beforePasteData.custom = clipboardData.getData( 'text/xcustom' );
		this.beforePasteData.html = clipboardData.getData( 'text/html' );
		if ( this.beforePasteData.html ) {
			// http://msdn.microsoft.com/en-US/en-%20us/library/ms649015(VS.85).aspx
			this.beforePasteData.html = this.beforePasteData.html
				.replace( /^[\s\S]*<!-- *StartFragment *-->/, '' )
				.replace( /<!-- *EndFragment *-->[\s\S]*$/, '' );
		}
	}

	// Save scroll position before changing focus to "offscreen" paste target
	this.beforePasteData.scrollTop = this.$window.scrollTop();

	this.$pasteTarget.empty();

	// Get node from cursor position
	startNode = documentModel.getBranchNodeFromOffset( range.start );
	if ( startNode.canContainContent() ) {
		// If this is a content branch node, then add its DM HTML
		// to the paste target to give CE some context.
		textStart = textEnd = 0;
		contextElement = startNode.getClonedElement();
		// Make sure that context doesn't have any attributes that might confuse
		// the importantElement check in afterPaste.
		$( documentModel.getStore().value( contextElement.originalDomElementsHash ) ).removeAttr( 'id typeof rel' );
		context = [ contextElement ];
		// If there is content to the left of the cursor, put a placeholder
		// character to the left of the cursor
		if ( range.start > startNode.getRange().start ) {
			leftText = '☀';
			context.push( leftText );
			textStart = textEnd = 1;
		}
		// If there is content to the right of the cursor, put a placeholder
		// character to the right of the cursor
		endNode = documentModel.getBranchNodeFromOffset( range.end );
		if ( range.end < endNode.getRange().end ) {
			rightText = '☂';
			context.push( rightText );
		}
		// If there is no text context, select some text to be replaced
		if ( !leftText && !rightText ) {
			context.push( '☁' );
			textEnd = 1;
		}
		context.push( { type: '/' + context[ 0 ].type } );

		// Throw away 'internal', specifically inner whitespace,
		// before conversion as it can affect textStart/End offsets.
		delete contextElement.internal;
		ve.dm.converter.getDomSubtreeFromModel(
			documentModel.cloneWithData( context, true ),
			this.$pasteTarget[ 0 ]
		);

		// Giving the paste target focus too late can cause problems in FF (!?)
		// so do it up here.
		this.$pasteTarget[ 0 ].focus();

		nativeRange = this.getElementDocument().createRange();
		// Assume that the DM node only generated one child
		textNode = this.$pasteTarget.children().contents()[ 0 ];
		// Place the cursor between the placeholder characters
		nativeRange.setStart( textNode, textStart );
		nativeRange.setEnd( textNode, textEnd );
		this.nativeSelection.removeAllRanges();
		this.nativeSelection.addRange( nativeRange );

		this.beforePasteData.context = context;
		this.beforePasteData.leftText = leftText;
		this.beforePasteData.rightText = rightText;
	} else {
		// If we're not in a content branch node, don't bother trying to do
		// anything clever with paste context
		this.$pasteTarget[ 0 ].focus();
	}

	// Restore scroll position after focusing the paste target
	this.$window.scrollTop( this.beforePasteData.scrollTop );

};

/**
 * Handle post-paste events.
 *
 * @param {jQuery.Event} e Paste event
 * @return {jQuery.Promise} Promise which resolves when the content has been pasted
 */
ve.ce.Surface.prototype.afterPaste = function () {
	var pasteData, isMultiline, pending, tableAction,
		surfaceModel = this.getModel(),
		documentModel = surfaceModel.getDocument(),
		fragment = surfaceModel.getFragment(),
		targetFragment = surfaceModel.getFragment( null, true ),
		view = this,
		beforePasteData = this.beforePasteData || {},
		done = ve.createDeferred().resolve().promise();

	// If the selection doesn't collapse after paste then nothing was inserted
	if ( !this.nativeSelection.isCollapsed ) {
		return done;
	}

	if ( this.getModel().getFragment().isNull() ) {
		return done;
	}

	pasteData = this.afterPasteExtractClipboardData();

	// Handle pastes into a table
	if ( fragment.getSelection() instanceof ve.dm.TableSelection ) {
		// Internal table-into-table paste can be shortcut
		if ( fragment.getSelection() instanceof ve.dm.TableSelection && pasteData.slice instanceof ve.dm.TableSlice ) {
			tableAction = new ve.ui.TableAction( this.getSurface() );
			tableAction.importTable( pasteData.slice.getTableNode( documentModel ) );
			return ve.createDeferred().resolve().promise();
		}

		// For table selections the target is the first cell
		targetFragment = surfaceModel.getLinearFragment( fragment.getSelection().getRanges( documentModel )[ 0 ], true );
	}

	// Are we pasting into a multiline context?
	isMultiline = this.getDocument().getBranchNodeFromOffset(
		targetFragment.getSelection().getCoveringRange().from
	).isMultiline();

	if ( pasteData.slice ) {
		pending = this.afterPasteAddToFragmentFromInternal( pasteData.slice, fragment, targetFragment, isMultiline );
	} else {
		pending = this.afterPasteAddToFragmentFromExternal( pasteData.clipboardKey, pasteData.$clipboardHtml, fragment, targetFragment, isMultiline );
	}
	return pending.then( function () {
		if ( view.getSelection().isNativeCursor() ) {
			// Restore focus and scroll position
			view.$attachedRootNode[ 0 ].focus();
			view.$window.scrollTop( beforePasteData.scrollTop );
			// setTimeout: Firefox sometimes doesn't change scrollTop immediately when pasting
			// line breaks at the end of a line so do it again later.
			setTimeout( function () {
				view.$window.scrollTop( beforePasteData.scrollTop );
			} );
		}

		// If original selection was linear, switch to end of pasted text
		if ( fragment.getSelection() instanceof ve.dm.LinearSelection ) {
			targetFragment.collapseToEnd().select();
			view.checkSequences( /* isPaste */ true );
		}
	} );
};

/**
 * Extract the clipboard key and other relevant data from beforePasteData / the paste target
 * @return {Object} Data
 * @return {string|undefined} return.clipboardKey Clipboard key, if present
 * @return {jQuery|undefined} return.$clipboardHtml Clipboard html, if used to extract the clipboard key
 * @return {ve.dm.DocumentSlice|undefined} return.slice Relevant slice of this document, if the key points to it
 */
ve.ce.Surface.prototype.afterPasteExtractClipboardData = function () {
	var clipboardKey, clipboardHash, $clipboardHtml, slice,
		beforePasteData = this.beforePasteData || {};

	// Find the clipboard key
	if ( beforePasteData.custom ) {
		// text/xcustom was present, and requires no further processing
		clipboardKey = beforePasteData.custom;
	} else {
		if ( beforePasteData.html ) {
			// text/html was present, so we can check if a key was hidden in it
			$clipboardHtml = $( $.parseHTML( beforePasteData.html ) ).filter( function () {
				var val = this.getAttribute && this.getAttribute( 'data-ve-clipboard-key' );
				if ( val ) {
					clipboardKey = val;
					// Remove the clipboard key span once read
					return false;
				}
				return true;
			} );
			clipboardHash = this.constructor.static.getClipboardHash( $clipboardHtml );
		} else {
			// fall back on checking the pasteTarget

			// HTML in pasteTarget may get wrapped, so use the recursive $.find to look for the clipboard key
			clipboardKey = this.$pasteTarget.find( 'span[data-ve-clipboard-key]' ).data( 've-clipboard-key' );
			// Pass beforePasteData so context gets stripped
			clipboardHash = this.constructor.static.getClipboardHash( this.$pasteTarget, beforePasteData );
		}
	}

	// If we have a clipboard key, validate it and fetch data
	if ( clipboardKey === this.clipboardId + '-' + this.clipboardIndex ) {
		// Hash validation: either text/xcustom was used or the hash must be
		// equal to the hash of the pasted HTML to assert that the HTML
		// hasn't been modified in another editor before being pasted back.
		if ( beforePasteData.custom || clipboardHash === this.clipboard.hash ) {
			slice = this.clipboard.slice;
			// Clone again. The elements were cloned on copy, but we need to clone
			// on paste too in case the same thing is pasted multiple times.
			slice.data.cloneElements( true );
		}
	}

	if ( !slice && !$clipboardHtml && beforePasteData.html ) {
		$clipboardHtml = $( $.parseHTML( beforePasteData.html ) );
	}

	return {
		clipboardKey: clipboardKey,
		$clipboardHtml: $clipboardHtml,
		slice: slice
	};
};

/**
 * LinearData sanitize helper, for pasted data
 *
 * @param {ve.dm.LinearData} linearData Data to sanitize
 * @param {boolean} isMultiline Sanitize for a multiline context
 * @param {boolean} isExternal Treat as external content
 */
ve.ce.Surface.prototype.afterPasteSanitize = function ( linearData, isMultiline, isExternal ) {
	var importRules = this.afterPasteImportRules( isMultiline );
	if ( isExternal ) {
		linearData.sanitize( importRules.external || {} );
	}
	linearData.sanitize( importRules.all || {} );
};

/**
 * Helper to build import rules for pasted data
 * @param {boolean} isMultiline Get rules for a multiline context
 * @return {Object} Import rules
 */
ve.ce.Surface.prototype.afterPasteImportRules = function ( isMultiline ) {
	var importRules = !this.pasteSpecial ? this.getSurface().getImportRules() : { all: { plainText: true, keepEmptyContentBranches: true } };
	if ( !isMultiline ) {
		importRules = {
			all: ve.extendObject( {}, importRules.all, { singleLine: true } ),
			external: ve.extendObject( {}, importRules.external, { singleLine: true } )
		};
	}
	return importRules;
};

/**
 * After paste handler for pastes from the same document
 * @param {ve.dm.DocumentSlice} slice Slice of document to paste
 * @param {ve.dm.SurfaceFragment} fragment Current fragment
 * @param {ve.dm.SurfaceFragment} targetFragment Fragment to insert into
 * @param {boolean} isMultiline Pasting to a multiline context
 * @return {jQuery.Promise} Promise which resolves when the content has been inserted
 */
ve.ce.Surface.prototype.afterPasteAddToFragmentFromInternal = function ( slice, fragment, targetFragment, isMultiline ) {
	var linearData, data, insertionPromise;

	// Pasting non-table content into table: just replace the first cell with the pasted content
	if ( fragment.getSelection() instanceof ve.dm.TableSelection ) {
		// Cell was not deleted in beforePaste to prevent flicker when table-into-table paste is
		// about to be triggered.
		targetFragment.removeContent();
	}

	// Only try original data in multiline contexts, for single line we must use balanced data

	// Original data + fixupInsertion
	if ( isMultiline ) {
		// Take a copy to prevent the data being annotated a second time in the balanced data path
		// and to prevent actions in the data model affecting view.clipboard
		linearData = new ve.dm.ElementLinearData(
			slice.getStore(),
			ve.copy( slice.getOriginalData() )
		);

		if ( this.pasteSpecial ) {
			this.afterPasteSanitize( linearData, isMultiline );
		}

		// ve.dm.Document#fixupInsertion may fail, in which case we fall back to balanced data
		try {
			insertionPromise = this.afterPasteInsertInternalData( targetFragment, linearData.getData() );
		} catch ( e ) {}
	}

	// Balanaced data
	if ( !insertionPromise ) {
		// Take a copy to prevent actions in the data model affecting view.clipboard
		linearData = new ve.dm.ElementLinearData(
			slice.getStore(),
			ve.copy( slice.getBalancedData() )
		);

		if ( this.pasteSpecial || !isMultiline ) {
			this.afterPasteSanitize( linearData, isMultiline );
		}

		data = linearData.getData();

		if ( !isMultiline ) {
			// Unwrap single CBN
			if ( data[ 0 ].type ) {
				data = data.slice( 1, data.length - 1 );
			}
		}

		insertionPromise = this.afterPasteInsertInternalData( targetFragment, data );
	}

	return insertionPromise;
};

/**
 * Insert some pasted data from an internal source
 * @param {ve.dm.SurfaceFragment} targetFragment Fragment to insert into
 * @param {Array} data Data to insert
 * @return {jQuery.Promise} Promise which resolves when the content has been inserted
 */
ve.ce.Surface.prototype.afterPasteInsertInternalData = function ( targetFragment, data ) {
	targetFragment.insertContent( data, true );
	return targetFragment.getPending();
};

/**
 * After paste handler for pastes from the another document
 * @param {string|undefined} clipboardKey] Clipboard key for pasted data
 * @param {jQuery|undefined} $clipboardHtml Clipboard HTML, if used to find the key
 * @param {ve.dm.SurfaceFragment} fragment Current fragment
 * @param {ve.dm.SurfaceFragment} targetFragment Fragment to insert into
 * @param {boolean} [isMultiline] Pasting to a multiline context
 * @param {boolean} [forceClipboardData] Ignore the paste target, and use only clipboard html
 * @return {jQuery.Promise} Promise which resolves when the content has been inserted
 */
ve.ce.Surface.prototype.afterPasteAddToFragmentFromExternal = function ( clipboardKey, $clipboardHtml, fragment, targetFragment, isMultiline, forceClipboardData ) {
	var data, $body, $images, i, htmlDoc, htmlBlacklist, pastedDocumentModel, tableAction, contextRange, pastedNodes,
		importantElement = '[id],[typeof],[rel]',
		items = [],
		surfaceModel = this.getModel(),
		documentModel = surfaceModel.getDocument(),
		beforePasteData = this.beforePasteData || {};

	if ( ( clipboardKey || forceClipboardData ) && $clipboardHtml ) {
		// If the clipboardKey is set (paste from other VE instance), and clipboard
		// data is available, then make sure important elements haven't been dropped
		if (
			forceClipboardData ||
			// FIXME T126045: Allow the test runner to force the use of clipboardData
			clipboardKey === 'useClipboardData-0' ||
			$clipboardHtml.find( importantElement ).addBack( importantElement ).length > this.$pasteTarget.find( importantElement ).length
		) {
			// CE destroyed an important element, so revert to using clipboard data
			htmlDoc = ve.createDocumentFromHtml( beforePasteData.html );
			$( htmlDoc )
				// Remove the pasteProtect class. See #onCopy.
				.find( 'span' ).removeClass( 've-pasteProtect' ).end()
				// Remove the clipboard key
				.find( 'span[data-ve-clipboard-key]' ).remove().end()
				// Remove ve-attributes
				.find( '[data-ve-attributes]' ).removeAttr( 'data-ve-attributes' );
			beforePasteData.context = null;
		}
	}
	if ( !htmlDoc ) {
		// If there were no problems, let CE do its sanitizing as it may
		// contain all sorts of horrible metadata (head tags etc.)
		// TODO: IE will always take this path, and so may have bugs with span unwrapping
		// in edge cases (e.g. pasting a single MWReference)
		htmlDoc = ve.createDocumentFromHtml( this.$pasteTarget.html() );
	}
	// Some browsers don't provide pasted image data through the clipboardData API and
	// instead create img tags with data URLs, so detect those here
	$body = $( htmlDoc.body );
	$images = $body.children( 'img[src^=data\\:]' );
	// Check the body contained just children.
	// TODO: In the future this may want to trigger image uploads *and* paste the HTML.
	if ( $images.length === $body.children().length ) {
		for ( i = 0; i < $images.length; i++ ) {
			items.push( ve.ui.DataTransferItem.static.newFromDataUri(
				$images.eq( i ).attr( 'src' ),
				$images[ i ].outerHTML
			) );
		}
		if ( this.handleDataTransferItems( items, true ) ) {
			return ve.createDeferred().resolve().promise();
		}
	}

	this.afterPasteSanitizeExternal( $( htmlDoc.body ) );

	// HACK: Fix invalid HTML from Google Docs nested lists (T98100).
	// Converts
	// <ul><li>A</li><ul><li>B</li></ul></ul>
	// to
	// <ul><li>A<ul><li>B</li></ul></li></ul>
	$( htmlDoc.body ).find( 'ul > ul, ul > ol, ol > ul, ol > ol' ).each( function () {
		if ( this.previousElementSibling ) {
			this.previousElementSibling.appendChild( this );
		} else {
			// List starts double indented. This is invalid and a semantic nightmare.
			// Just wrap with an extra list item
			$( this ).wrap( '<li>' );
		}
	} );

	// HTML sanitization
	htmlBlacklist = ve.getProp( this.afterPasteImportRules( isMultiline ), 'external', 'htmlBlacklist' );
	if ( htmlBlacklist && !clipboardKey ) {
		if ( htmlBlacklist.remove ) {
			htmlBlacklist.remove.forEach( function ( selector ) {
				$( htmlDoc.body ).find( selector ).remove();
			} );
		}
		if ( htmlBlacklist.unwrap ) {
			htmlBlacklist.unwrap.forEach( function ( selector ) {
				$( htmlDoc.body ).find( selector ).contents().unwrap();
			} );
		}
	}

	// External paste
	pastedDocumentModel = ve.dm.converter.getModelFromDom( htmlDoc, {
		targetDoc: documentModel.getHtmlDocument(),
		fromClipboard: true
	} );
	data = pastedDocumentModel.data;
	// Clone again
	data.cloneElements( true );

	// Sanitize
	this.afterPasteSanitize( data, isMultiline, !clipboardKey );

	data.remapInternalListKeys( documentModel.getInternalList() );

	// Initialize node tree
	pastedDocumentModel.buildNodeTree();

	if ( fragment.getSelection() instanceof ve.dm.TableSelection ) {
		// External table-into-table paste
		if (
			pastedDocumentModel.documentNode.children.length === 2 &&
			pastedDocumentModel.documentNode.children[ 0 ] instanceof ve.dm.TableNode
		) {
			tableAction = new ve.ui.TableAction( this.getSurface() );
			tableAction.importTable( pastedDocumentModel.documentNode.children[ 0 ], true );
			return ve.createDeferred().resolve().promise();
		}

		// Pasting non-table content into table: just replace the first cell with the pasted content
		// Cell was not deleted in beforePaste to prevent flicker when table-into-table paste is about to be triggered.
		targetFragment.removeContent();
	}

	if ( beforePasteData.context ) {
		// If the paste was given context, calculate the range of the inserted data
		contextRange = this.afterPasteFromExternalContextRange( pastedDocumentModel, isMultiline, forceClipboardData );
		if ( !contextRange ) {
			return this.afterPasteAddToFragmentFromExternal( clipboardKey, $clipboardHtml, fragment, targetFragment, isMultiline, true );
		}
	} else {
		contextRange = pastedDocumentModel.getDocumentRange();
	}
	pastedNodes = pastedDocumentModel.selectNodes( contextRange, 'siblings' ).filter( function ( node ) {
		// Ignore nodes where nothing is selected
		return !( node.range && node.range.isCollapsed() );
	} );

	// Unwrap single content branch nodes to match internal copy/paste behaviour
	// (which wouldn't put the open and close tags in the clipboard to begin with).
	if (
		pastedNodes.length === 1 &&
		pastedNodes[ 0 ].node.canContainContent()
	) {
		if ( contextRange.containsRange( pastedNodes[ 0 ].nodeRange ) ) {
			contextRange = pastedNodes[ 0 ].nodeRange;
		}
	}

	return this.afterPasteInsertExternalData( targetFragment, pastedDocumentModel, contextRange );
};

/**
 * Insert some pasted data from an external source
 * @param {ve.dm.SurfaceFragment} targetFragment Fragment to insert into
 * @param {ve.dm.Document} pastedDocumentModel Model generated from pasted data
 * @param {ve.Range} contextRange Range of data in generated model to consider
 * @return {jQuery.Promise} Promise which resolves when the content has been inserted
 */
ve.ce.Surface.prototype.afterPasteInsertExternalData = function ( targetFragment, pastedDocumentModel, contextRange ) {
	var pastedText, handled;
	// If the external HTML turned out to be plain text after sanitization
	// then run it as a plain text transfer item. In core this will never
	// do anything, but implementations can provide their own handler for
	// conversion actions here.
	if ( pastedDocumentModel.data.isPlainText( contextRange, true, undefined, true ) ) {
		pastedText = pastedDocumentModel.data.getText( true, contextRange );
		if ( pastedText ) {
			handled = this.handleDataTransferItems(
				[ ve.ui.DataTransferItem.static.newFromString( pastedText ) ],
				true,
				targetFragment
			);
		}
	}
	if ( !handled ) {
		targetFragment.insertDocument( pastedDocumentModel, contextRange, true );
	}
	return targetFragment.getPending();
};

/**
 * Helper to work out the context range for an external paste
 * @param {ve.dm.Document} pastedDocumentModel Model for pasted data
 * @param {boolean} isMultiline Whether pasting to a multiline context
 * @param {boolean} forceClipboardData Whether the current attempted paste is the result of forcing use of clipboard data
 * @return {ve.Range|boolean} Context range, or false if data appeared corrupted
 */
ve.ce.Surface.prototype.afterPasteFromExternalContextRange = function ( pastedDocumentModel, isMultiline, forceClipboardData ) {
	var leftText, rightText, left, right,
		data = pastedDocumentModel.data,
		documentRange = pastedDocumentModel.getDocumentRange(),
		beforePasteData = this.beforePasteData || {},
		context = new ve.dm.ElementLinearData(
			pastedDocumentModel.getStore(),
			ve.copy( beforePasteData.context )
		);
	// Sanitize context to match data
	this.afterPasteSanitize( context, isMultiline );

	leftText = beforePasteData.leftText;
	rightText = beforePasteData.rightText;

	// Remove matching context from the left
	left = 0;
	while (
		context.getLength() &&
		ve.dm.ElementLinearData.static.compareElementsUnannotated(
			data.getData( left ),
			data.isElementData( left ) ? context.getData( 0 ) : leftText
		)
	) {
		if ( !data.isElementData( left ) ) {
			// Text context is removed
			leftText = '';
		}
		left++;
		context.splice( 0, 1 );
	}

	// Remove matching context from the right
	right = documentRange.end;
	while (
		right > 0 &&
		context.getLength() &&
		ve.dm.ElementLinearData.static.compareElementsUnannotated(
			data.getData( right - 1 ),
			data.isElementData( right - 1 ) ? context.getData( context.getLength() - 1 ) : rightText
		)
	) {
		if ( !data.isElementData( right - 1 ) ) {
			// Text context is removed
			rightText = '';
		}
		right--;
		context.splice( context.getLength() - 1, 1 );
	}
	if ( ( leftText || rightText ) && !forceClipboardData ) {
		// If any text context is left over, assume the paste target got corrupted
		// so we should start again and try to use clipboardData instead. T193110
		return false;
	}
	// Support: Chrome
	// FIXME T126046: Strip trailing linebreaks probably introduced by Chrome bug
	while ( right > 0 && data.getType( right - 1 ) === 'break' ) {
		right--;
	}
	return new ve.Range( left, right );
};

/**
 * Helper to clean up externally pasted HTML (via pasteTarget).
 *
 * @param {jQuery} $element Root element containing pasted stuff to sanitize
 */
ve.ce.Surface.prototype.afterPasteSanitizeExternal = function ( $element ) {
	var metadataIdRegExp = ve.init.platform.getMetadataIdRegExp();

	// Remove the clipboard key
	$element.find( 'span[data-ve-clipboard-key]' ).remove();
	// Remove style tags (T185532)
	$element.find( 'style' ).remove();
	// If this is from external, run extra sanitization:

	// Do some simple transforms to catch content that is using
	// spans+styles instead of regular tags. This is very much targeted at
	// the output of Google Docs, but should work with anything fairly-
	// similar. This is *fragile*, but more in the sense that small
	// deviations will stop it from working, rather than it being terribly
	// likely to incorrectly over-format things.
	// TODO: This might be cleaner if we could move the sanitization into
	// dm.converter entirely.
	$element.find( 'span' ).each( function ( i, node ) {
		var $node;
		// Later sanitization will replace completely-empty spans with
		// their contents, so we can lazily-wrap here without cleaning
		// up.
		if ( !node.style ) {
			return;
		}
		$node = $( node );
		if ( +node.style.fontWeight >= 700 || node.style.fontWeight === 'bold' ) {
			$node.wrap( '<b>' );
		}
		if ( node.style.fontStyle === 'italic' ) {
			$node.wrap( '<i>' );
		}
		if ( node.style.textDecorationLine === 'underline' ) {
			$node.wrap( '<u>' );
		}
		if ( node.style.textDecorationLine === 'line-through' ) {
			$node.wrap( '<s>' );
		}
		if ( node.style.verticalAlign === 'super' ) {
			$node.wrap( '<sup>' );
		}
		if ( node.style.verticalAlign === 'sub' ) {
			$node.wrap( '<sub>' );
		}
	} );

	// Remove style attributes. Any valid styles will be restored by data-ve-attributes.
	$element.find( '[style]' ).removeAttr( 'style' );

	if ( metadataIdRegExp ) {
		$element.find( '[id]' ).each( function () {
			var $this = $( this );
			if ( $this.attr( 'id' ).match( metadataIdRegExp ) ) {
				$this.removeAttr( 'id' );
			}
		} );
	}

	// Remove the pasteProtect class (see #onCopy) and unwrap empty spans.
	$element.find( 'span' ).each( function () {
		var $this = $( this );
		$this.removeClass( 've-pasteProtect' );
		if ( $this.attr( 'class' ) === '' ) {
			$this.removeAttr( 'class' );
		}
		// Unwrap empty spans
		if ( !this.attributes.length ) {
			$this.replaceWith( this.childNodes );
		}
	} );

	// Restore attributes. See #onCopy.
	$element.find( '[data-ve-attributes]' ).each( function () {
		var attrs,
			attrsJSON = this.getAttribute( 'data-ve-attributes' );

		// Always remove the attribute, even if the JSON has been corrupted
		this.removeAttribute( 'data-ve-attributes' );

		try {
			attrs = JSON.parse( attrsJSON );
		} catch ( err ) {
			// Invalid JSON
			return;
		}
		$( this ).attr( attrs );
	} );
};

/**
 * Handle the insertion of a data transfer object
 *
 * @param {DataTransfer} dataTransfer Data transfer
 * @param {boolean} isPaste Handlers being used for paste
 * @param {ve.dm.SurfaceFragment} [targetFragment] Fragment to insert data items at, defaults to current selection
 * @return {boolean} One more items was handled
 */
ve.ce.Surface.prototype.handleDataTransfer = function ( dataTransfer, isPaste, targetFragment ) {
	var i, l, pushItemToBack,
		items = [],
		htmlStringData = dataTransfer.getData( 'text/html' ),
		htmlPreParse, imgCount = 0, hasContent = false;

	// Rules for clipboard content selection:
	//  1. If the clipboard has only HTML, proceed parsing such HTML.
	//  2. If the clipboard has only files, process them as-is.
	//  3. If the clipboard has both:
	//    a. If the HTML in the clipboard contains only images and other elements with no text, process the image files.
	//    b. Otherwise, ignore the files and process the HTML.
	//
	// Notes:
	//  - If a file is pasted/dropped, it may have HTML fallback, such as an IMG node with alt text, for example.
	//  - HTML generated from some clients has an image fallback(!) that is a screenshot of the HTML snippet (e.g. LibreOffice Calc)
	if ( !htmlStringData ) {
		if ( dataTransfer.items ) {
			for ( i = 0, l = dataTransfer.items.length; i < l; i++ ) {
				if ( dataTransfer.items[ i ].kind !== 'string' ) {
					items.push( ve.ui.DataTransferItem.static.newFromItem( dataTransfer.items[ i ], htmlStringData ) );
				}
			}
		} else if ( dataTransfer.files ) {
			for ( i = 0, l = dataTransfer.files.length; i < l; i++ ) {
				items.push( ve.ui.DataTransferItem.static.newFromBlob( dataTransfer.files[ i ], htmlStringData ) );
			}
		}
	} else if ( dataTransfer.files ) {
		htmlPreParse = $.parseHTML( htmlStringData );

		for ( i = 0; i < htmlPreParse.length; i++ ) {
			// Count images in root nodes
			if ( htmlPreParse[ i ].nodeName === 'IMG' ) {
				imgCount++;
			} else if (
				( htmlPreParse[ i ].nodeType === 1 || htmlPreParse[ i ].nodeType === 3 ) &&
				htmlPreParse[ i ].textContent &&
				htmlPreParse[ i ].textContent.trim() !== ''
			) {
				// Only count element nodes (type 1) or text nodes (type 3)
				// that have non empty text content.
				hasContent = true;
			}

			// Count images in children
			if ( typeof htmlPreParse[ i ].querySelectorAll === 'function' ) {
				imgCount += htmlPreParse[ i ].querySelectorAll( 'img' ).length;
			}
		}

		if ( !hasContent && imgCount === dataTransfer.files.length ) {
			for ( i = 0, l = dataTransfer.files.length; i < l; i++ ) {
				// TODO: should we use image node outerHTML instead of htmlStringData?
				items.push( ve.ui.DataTransferItem.static.newFromBlob( dataTransfer.files[ i ], htmlStringData ) );
			}
		}
	}

	if ( dataTransfer.items ) {
		// Extract "string" types.
		for ( i = 0, l = dataTransfer.items.length; i < l; i++ ) {
			if (
				dataTransfer.items[ i ].kind === 'string' &&
				dataTransfer.items[ i ].type.substr( 0, 5 ) === 'text/'
			) {
				items.push( ve.ui.DataTransferItem.static.newFromString(
					dataTransfer.getData( dataTransfer.items[ i ].type ),
					dataTransfer.items[ i ].type,
					htmlStringData
				) );
			}
		}
	}

	// We care a little bit about the order of items, as the first one matched
	// is going to be the one we handle, and don't trust dataTransfer.items to
	// be in the fallback order we'd prefer. In practice, this just means that
	// we want to text/html and text/plain to be at the end of the list, as
	// they tend to show up as common fallbacks.
	pushItemToBack = function ( array, type ) {
		var i, l;
		for ( i = 0, l = array.length; i < l; i++ ) {
			if ( array[ i ].type === type ) {
				return array.push( array.splice( i, 1 )[ 0 ] );
			}
		}
	};
	pushItemToBack( items, 'text/html' );
	pushItemToBack( items, 'text/plain' );

	return this.handleDataTransferItems( items, isPaste, targetFragment );
};

/**
 * Handle the insertion of data transfer items
 *
 * @param {ve.ui.DataTransferItem[]} items Data transfer items
 * @param {boolean} isPaste Handlers being used for paste
 * @param {ve.dm.SurfaceFragment} [targetFragment] Fragment to insert data items at, defaults to current selection
 * @return {boolean} One more items was handled
 */
ve.ce.Surface.prototype.handleDataTransferItems = function ( items, isPaste, targetFragment ) {
	var i, l, name, item,
		dataTransferHandlerFactory = this.getSurface().dataTransferHandlerFactory,
		handled = false;

	targetFragment = targetFragment || this.getModel().getFragment();

	function insert( docOrData ) {
		// For non-paste transfers, don't overwrite the selection
		var resultFragment = !isPaste ? targetFragment.collapseToEnd() : targetFragment;
		if ( docOrData instanceof ve.dm.Document ) {
			resultFragment.insertDocument( docOrData );
		} else {
			resultFragment.insertContent( docOrData );
		}
		// The resultFragment's selection now covers the inserted content;
		// adjust selection to end of inserted content.
		resultFragment.collapseToEnd().select();
	}

	for ( i = 0, l = items.length; i < l; i++ ) {
		item = items[ i ];
		name = dataTransferHandlerFactory.getHandlerNameForItem( item, isPaste, this.pasteSpecial );
		if ( name ) {
			dataTransferHandlerFactory.create( name, this.surface, item )
				.getInsertableData().done( insert );
			handled = true;
			break;
		} else if ( isPaste && item.type === 'text/html' ) {
			// Don't handle anything else if text/html is available, as it is handled specially in #afterPaste
			break;
		}
	}
	return handled;
};

/**
 * Select all the contents within the current context
 */
ve.ce.Surface.prototype.selectAll = function () {
	var documentRange, range, matrix, activeNode,
		selection = this.getModel().getSelection(),
		dmDoc = this.getModel().getDocument();

	if ( selection instanceof ve.dm.LinearSelection ) {
		activeNode = this.getActiveNode();
		if ( activeNode ) {
			range = activeNode.getRange();
			range = new ve.Range( range.from + 1, range.to - 1 );
		} else {
			documentRange = this.getModel().getDocument().getDocumentRange();
			range = new ve.Range(
				dmDoc.getNearestCursorOffset( 0, 1 ),
				dmDoc.getNearestCursorOffset( documentRange.end, -1 )
			);
		}
		this.getModel().setLinearSelection( range );
	} else if ( selection instanceof ve.dm.TableSelection ) {
		matrix = selection.getTableNode( dmDoc ).getMatrix();
		this.getModel().setSelection(
			new ve.dm.TableSelection(
				selection.tableRange,
				0, 0, matrix.getMaxColCount() - 1, matrix.getRowCount() - 1
			)
		);
	}
};

/**
 * Handle input events.
 *
 * @method
 * @param {jQuery.Event} e The input event
 */
ve.ce.Surface.prototype.onDocumentInput = function ( e ) {
	// Synthetic events don't have the originalEvent property (T176104)
	var inputType = e.originalEvent ? e.originalEvent.inputType : null,
		inputTypeCommands = this.constructor.static.inputTypeCommands;

	if (
		inputType &&
		Object.prototype.hasOwnProperty.call( inputTypeCommands, inputType )
	) {
		// Value can be null, in which case we still want to preventDefault.
		if ( inputTypeCommands[ inputType ] ) {
			this.getSurface().executeCommand( this.constructor.static.inputTypeCommands[ inputType ] );
		}
		e.preventDefault();
		return;
	}
	this.incRenderLock();
	try {
		this.surfaceObserver.pollOnce();
	} finally {
		this.decRenderLock();
	}
};

/**
 * Handle compositionstart events.
 * Note that their meaning varies between browser/OS/IME combinations
 *
 * @method
 * @param {jQuery.Event} e The compositionstart event
 */
ve.ce.Surface.prototype.onDocumentCompositionStart = function () {
	// Eagerly trigger emulated deletion on certain selections, to ensure a ContentEditable
	// native node merge never happens. See https://phabricator.wikimedia.org/T123716 .
	if (
		this.model.selection instanceof ve.dm.TableSelection &&
		$.client.profile().layout === 'gecko'
	) {
		// Support: Firefox
		// Work around a segfault on blur+focus in Firefox compositionstart handlers.
		// It would get triggered by handleInsertion emptying the table cell then putting
		// a linear selection inside it. See:
		// https://phabricator.wikimedia.org/T86589
		// https://bugzilla.mozilla.org/show_bug.cgi?id=1230473
		return;
	}
	this.handleInsertion();
};

/* Custom Events */

/**
 * Handle model select events.
 *
 * @see ve.dm.Surface#method-change
 */
ve.ce.Surface.prototype.onModelSelect = function () {
	var focusedNode, blockSlug,
		selection = this.getModel().getSelection();

	setTimeout( this.checkDelayedSequences.bind( this ) );

	this.cursorDirectionality = null;
	this.contentBranchNodeChanged = false;
	this.selection = null;

	if ( selection.isNull() ) {
		this.removeCursorHolders();
	}

	if ( selection instanceof ve.dm.LinearSelection ) {
		blockSlug = this.findBlockSlug( selection.getRange() );
		if ( blockSlug !== this.focusedBlockSlug ) {
			if ( this.focusedBlockSlug ) {
				this.focusedBlockSlug.classList.remove(
					've-ce-branchNode-blockSlug-focused'
				);
				this.focusedBlockSlug = null;
			}

			if ( blockSlug ) {
				blockSlug.classList.add( 've-ce-branchNode-blockSlug-focused' );
				this.focusedBlockSlug = blockSlug;
				this.preparePasteTargetForCopy();
			}
		}

		focusedNode = this.findFocusedNode( selection.getRange() );

		if ( this.deactivatedForCopy && !blockSlug && !focusedNode ) {
			// If preparePasteTargetForCopy deactivated the surface then
			// reactivate it here (no-op if already active). See T147304
			this.activate();
		}

		// If focus has changed, update nodes and this.focusedNode
		if ( focusedNode !== this.focusedNode ) {
			if ( this.focusedNode ) {
				this.focusedNode.setFocused( false );
				this.focusedNode = null;
			}
			if ( focusedNode ) {
				focusedNode.setFocused( true );
				this.focusedNode = focusedNode;

				// If dragging, we already have a native selection, so don't mess with it
				if ( !this.dragging ) {
					this.preparePasteTargetForCopy();
					// Since the selection is no longer in the root, clear the SurfaceObserver's
					// selection state. Otherwise, if the user places the selection back into the root
					// in exactly the same place where it was before, the observer won't consider that a change.
					this.surfaceObserver.clear();
				}
				// If the node is outside the view, scroll to it
				ve.scrollIntoView( this.focusedNode.$element.get( 0 ) );
			}
		}
	} else {
		if ( selection instanceof ve.dm.TableSelection ) {
			this.preparePasteTargetForCopy();
		}
		if ( this.focusedNode ) {
			this.focusedNode.setFocused( false );
		}
		this.focusedNode = null;
	}

	// Ignore the selection if changeModelSelection is currently being
	// called with the same (object-identical) selection object
	// (i.e. if the model is calling us back)
	if ( !this.isRenderingLocked() && selection !== this.newModelSelection ) {
		this.showModelSelection();
		this.cleanupUnicorns( false );
	}
	// Update the selection state in the SurfaceObserver
	this.surfaceObserver.pollOnceNoCallback();
};

/**
 * Prepare the paste target for a copy event by selecting some text
 */
ve.ce.Surface.prototype.preparePasteTargetForCopy = function () {
	// As FF won't fire a copy event with nothing selected, create a native selection.
	// If there is a focusedNode available, use its text content so that context menu
	// items such as "Search for [SELECTED TEXT]" make sense. If the text is empty or
	// whitespace, use a single unicode character as this is required for programmatic
	// selection to work correctly in all browsers (e.g. Safari won't select a single space).
	// #onCopy will ignore this native selection and use the DM selection
	if ( !OO.ui.isMobile() ) {
		this.$pasteTarget.text( ( this.focusedNode && this.focusedNode.$element.text().trim() ) || '☢' );
		ve.selectElement( this.$pasteTarget[ 0 ] );
		this.$pasteTarget[ 0 ].focus();
	} else {
		// Selecting the paste target fails on mobile:
		// * On iOS The selection stays visible and causes scrolling
		// * The user is unlikely to be able to trigger a keyboard copy anyway
		// Instead just deactivate the surface so the native cursor doesn't
		// get in the way and the on screen keyboard doesn't show.
		// TODO: Provide a copy tool in the context menu (T202278)
		this.deactivate( true );
	}
};

/**
 * Get the focused node (optionally at a specified range), or null if one is not present
 *
 * @param {ve.Range} [range] Optional range to check for focused node, defaults to current selection's range
 * @return {ve.ce.Node|null} Focused node
 */
ve.ce.Surface.prototype.getFocusedNode = function ( range ) {
	var selection;
	if ( !range ) {
		return this.focusedNode;
	}
	selection = this.getModel().getSelection();
	if (
		selection instanceof ve.dm.LinearSelection &&
		range.equalsSelection( selection.getRange() )
	) {
		return this.focusedNode;
	}
	return this.findFocusedNode( range );
};

/**
 * Find the block slug a given range is in.
 *
 * @param {ve.Range} range Range to check
 * @return {HTMLElement|null} Slug, or null if no slug or if range is not collapsed
 * @throws {Error} If range is inside internal list
 */
ve.ce.Surface.prototype.findBlockSlug = function ( range ) {
	var node;
	if ( !range.isCollapsed() ) {
		return null;
	}
	node = this.documentView.getBranchNodeFromOffset( range.end );
	if ( !node.canHaveChildrenNotContent() ) {
		// Node can not have block slugs (only inline slugs)
		return null;
	}
	return node.getSlugAtOffset( range.end );
};

/**
 * Find the focusedNode at a specified range
 *
 * @param {ve.Range} range Range to search at for a focusable node
 * @return {ve.ce.Node|null} Focused node
 */
ve.ce.Surface.prototype.findFocusedNode = function ( range ) {
	var startNode, endNode,
		documentNode = this.getDocument().getDocumentNode();
	// Detect when only a single focusable element is selected
	if ( !range.isCollapsed() ) {
		startNode = documentNode.getNodeFromOffset( range.start + 1 );
		if ( startNode && startNode.isFocusable() ) {
			endNode = documentNode.getNodeFromOffset( range.end - 1 );
			if ( startNode === endNode ) {
				return startNode;
			}
		}
	} else {
		// Check if the range is inside a focusable node with a collapsed selection
		startNode = documentNode.getNodeFromOffset( range.start );
		if ( startNode && startNode.isFocusable() ) {
			return startNode;
		}
	}
	return null;
};

/**
 * Handle documentUpdate events on the surface model.
 */
ve.ce.Surface.prototype.onModelDocumentUpdate = function () {
	var surface = this;
	if ( this.contentBranchNodeChanged ) {
		// Update the selection state from model
		this.onModelSelect();
	}
	// Update the state of the SurfaceObserver
	this.surfaceObserver.pollOnceNoCallback();
	// setTimeout: Wait for other documentUpdate listeners to run before emitting
	setTimeout( function () {
		surface.emit( 'position' );
	} );
};

/**
 * Handle insertionAnnotationsChange events on the surface model.
 *
 * @param {ve.dm.AnnotationSet} insertionAnnotations
 */
ve.ce.Surface.prototype.onInsertionAnnotationsChange = function () {
	var changed = this.renderSelectedContentBranchNode();
	if ( !changed ) {
		return;
	}
	// Must re-apply the selection after re-rendering
	this.forceShowModelSelection();
	this.surfaceObserver.pollOnceNoCallback();
};

/**
 * Get the ContentBranchNode containing the selection focus, if any
 *
 * @return {ve.ce.ContentBranchNode|null} ContentBranchNode containing selection focus, or null
 */
ve.ce.Surface.prototype.getSelectedContentBranchNode = function () {
	var node,
		selection = this.model.getSelection();

	if ( !( selection instanceof ve.dm.LinearSelection ) ) {
		return null;
	}
	node = this.documentView.getBranchNodeFromOffset( selection.getRange().to );
	if ( !node || !( node instanceof ve.ce.ContentBranchNode ) ) {
		return null;
	}
	return node;
};

/**
 * Re-render the ContentBranchNode containing the selection focus, if any
 *
 * @return {boolean} Whether a re-render actually happened
 */
ve.ce.Surface.prototype.renderSelectedContentBranchNode = function () {
	var node = this.getSelectedContentBranchNode();
	if ( !node ) {
		return false;
	}
	return node.renderContents();
};

/**
 * Handle changes observed from the DOM
 *
 * These are normally caused by the user interacting directly with the contenteditable.
 *
 * @param {ve.ce.RangeState|null} oldState The prior range state, if any
 * @param {ve.ce.RangeState} newState The changed range state
 */
ve.ce.Surface.prototype.handleObservedChanges = function ( oldState, newState ) {
	var newSelection, transaction, removedUnicorns, offset,
		activeNode, coveringRange, nodeRange, containsStart, containsEnd, blockSlug,
		surface = this,
		dmDoc = this.getModel().getDocument(),
		insertedText = false;

	if ( newState.contentChanged ) {
		if ( this.readOnly ) {
			newState.node.renderContents();
			this.showModelSelection();
			return;
		} else {
			transaction = newState.textState.getChangeTransaction(
				oldState.textState,
				dmDoc,
				newState.node.getOffset(),
				newState.node.unicornAnnotations
			);
			if ( transaction ) {
				this.incRenderLock();
				try {
					this.changeModel( transaction );
				} finally {
					this.decRenderLock();
				}
				insertedText = transaction.operations.filter( function ( op ) {
					return op.type === 'replace' && op.insert.length;
				} ).length > 0;
			}
		}
	}

	if (
		!this.readOnly &&
		newState.branchNodeChanged &&
		oldState &&
		oldState.node &&
		oldState.node.root &&
		oldState.node instanceof ve.ce.ContentBranchNode
	) {
		oldState.node.renderContents();
	}

	if ( newState.selectionChanged && !(
		// Ignore when the newRange is just a flipped oldRange
		oldState &&
		oldState.veRange &&
		newState.veRange &&
		!newState.veRange.isCollapsed() &&
		oldState.veRange.equalsSelection( newState.veRange )
	) ) {
		if ( newState.veRange ) {
			if ( newState.veRange.isCollapsed() ) {
				offset = dmDoc.getNearestCursorOffset( newState.veRange.from, 0 );
				if ( offset === -1 ) {
					// First, if we're in a document which outright doesn't
					// have any content to select, don't try to set one. These
					// would be niche documents, since slugs normally exist
					// and catch those cases.
					newSelection = new ve.dm.NullSelection();
					// TODO: Unset whatever native selection got us here, to match
					// the model state (assuming it is in the CE document)
				} else {
					// If we're placing the cursor, make sure it winds up in a
					// cursorable location. Failure to do this can result in
					// strange behavior when inserting content immediately after
					// clicking on the surface.
					newSelection = new ve.dm.LinearSelection( new ve.Range( offset ) );
				}
			} else {
				newSelection = new ve.dm.LinearSelection( newState.veRange );
			}
		} else {
			newSelection = new ve.dm.NullSelection();
		}
		this.incRenderLock();
		try {
			this.changeModel( null, newSelection );
			if ( newSelection instanceof ve.dm.LinearSelection && newSelection.isCollapsed() ) {
				blockSlug = this.findBlockSlug( newSelection.getRange() );
				if ( blockSlug ) {
					// Set the DOM selection, in case the model selection did not change but
					// the DOM selection did (T201599).
					this.preparePasteTargetForCopy();
					this.surfaceObserver.pollOnceNoCallback();
				}
			}
		} finally {
			this.decRenderLock();
		}
		removedUnicorns = this.cleanupUnicorns( false );
		if ( removedUnicorns ) {
			this.surfaceObserver.pollOnceNoCallback();
		}

		// Ensure we don't observe a selection that breaks out of the active node
		activeNode = this.getActiveNode();
		coveringRange = newSelection.getCoveringRange();
		if ( activeNode && coveringRange ) {
			nodeRange = activeNode.getRange();
			containsStart = nodeRange.containsRange( new ve.Range( coveringRange.start ) );
			containsEnd = nodeRange.containsRange( new ve.Range( coveringRange.end ) );
			// If the range starts xor ends in the active node, but not both, then it must
			// span an active node boundary, so fixup.
			if ( containsStart !== containsEnd ) {
				newSelection = oldState && oldState.veRange ?
					new ve.dm.LinearSelection( oldState.veRange ) :
					new ve.dm.NullSelection();
				// TODO: setTimeout: document purpose
				setTimeout( function () {
					surface.changeModel( null, newSelection );
					surface.showModelSelection();
				} );
			}
		}

		// Support: Firefox
		// Firefox lets you create multiple selections within a single paragraph
		// which our model doesn't support, so detect and prevent these.
		// This shouldn't create problems with IME candidates as only an explicit user
		// action can create a multiple selection (CTRL+click), and we remove it
		// immediately, so there can never be a multiple selection while the user is
		// typing text; therefore the selection change will never commit IME candidates
		// prematurely.
		while ( this.nativeSelection.rangeCount > 1 ) {
			// The current range is the last range, so remove ranges from the front
			this.nativeSelection.removeRange( this.nativeSelection.getRangeAt( 0 ) );
		}
	}

	if ( insertedText ) {
		surface.afterRenderLock( function () {
			surface.checkSequences();
			surface.maybeSetBreakpoint();
		} );
	}
	if ( newState.branchNodeChanged && newState.node ) {
		this.updateCursorHolders();
		this.showModelSelection();
	}
	if ( !insertedText ) {
		// Two likely cases here:
		// 1. The cursor moved. If so, fire off a breakpoint to catch any transactions
		//    that were pending, in case a word was being typed.
		// 2. Text was deleted. If so, make a breakpoint. A future enhancement could be
		//    to make this only break after a sequence of deletes. (Maybe combine new
		//    breakpoints with the former breakpoint based on the new transactions?)
		surface.getModel().breakpoint();
	}
};

/**
 * Create a slug out of a DOM element
 *
 * @param {HTMLElement} element Slug element
 */
ve.ce.Surface.prototype.createSlug = function ( element ) {
	var $slug,
		surface = this,
		offset = ve.ce.getOffsetOfSlug( element ),
		documentModel = this.getModel().getDocument();

	this.changeModel( ve.dm.TransactionBuilder.static.newFromInsertion(
		documentModel, offset, [
			{ type: 'paragraph', internal: { generated: 'slug' } },
			{ type: '/paragraph' }
		]
	), new ve.dm.LinearSelection( new ve.Range( offset + 1 ) ) );

	// Animate the slug open
	$slug = this.getDocument().getDocumentNode().getNodeFromOffset( offset + 1 ).$element;
	$slug.addClass( 've-ce-branchNode-newSlug' );
	// setTimeout: postpone until after animation is complete
	setTimeout( function () {
		$slug.addClass( 've-ce-branchNode-newSlug-open' );
		setTimeout( function () {
			surface.emit( 'position' );
		}, 200 );
	} );

	this.onModelSelect();
};

/**
 * Move cursor if it is between annotation nails
 *
 * @param {number} direction Direction of travel, 1=forwards, -1=backwards, 0=unknown
 * @param {boolean} extend Whether the anchor should stay where it is
 *
 * TODO: Improve name
 */
ve.ce.Surface.prototype.fixupCursorPosition = function ( direction, extend ) {
	var node, offset, previousNode, fixedPosition, nextNode;
	// Default to moving start-wards, to mimic typical Chromium behaviour
	direction = direction > 0 ? 1 : -1;

	if ( this.nativeSelection.rangeCount === 0 ) {
		return;
	}
	node = this.nativeSelection.focusNode;
	offset = this.nativeSelection.focusOffset;
	if ( node.nodeType !== Node.ELEMENT_NODE ) {
		return;
	}
	previousNode = node.childNodes[ offset - 1 ];
	nextNode = node.childNodes[ offset ];

	if (
		!(
			previousNode &&
			previousNode.nodeType === Node.ELEMENT_NODE && (
				previousNode.classList.contains( 've-ce-nail-pre-open' ) ||
				previousNode.classList.contains( 've-ce-nail-pre-close' )
			)
		) && !(
			nextNode &&
			nextNode.nodeType === Node.ELEMENT_NODE && (
				nextNode.classList.contains( 've-ce-nail-post-open' ) ||
				nextNode.classList.contains( 've-ce-nail-post-close' )
			)
		)
	) {
		return;
	}
	// Between nails: cross the one in the specified direction
	fixedPosition = ve.adjacentDomPosition(
		{ node: node, offset: offset },
		direction,
		{ stop: ve.isHardCursorStep }
	);
	node = fixedPosition.node;
	offset = fixedPosition.offset;
	if ( direction === -1 ) {
		// Support: Firefox
		// Moving startwards: left-bias the fixed position
		// Avoids Firefox bug "cursor disappears at left of img inside link":
		// https://bugzilla.mozilla.org/show_bug.cgi?id=1175495
		fixedPosition = ve.adjacentDomPosition(
			fixedPosition,
			direction,
			{ stop: ve.isHardCursorStep }
		);
		if ( fixedPosition.node.nodeType === Node.TEXT_NODE ) {
			// Have crossed into a text node; go back to its end
			node = fixedPosition.node;
			offset = fixedPosition.node.length;
		}
	}

	this.showSelectionState( new ve.SelectionState( {
		anchorNode: extend ? this.nativeSelection.anchorNode : node,
		anchorOffset: extend ? this.nativeSelection.anchorOffset : offset,
		focusNode: node,
		focusOffset: offset
	} ) );
};

/**
 * Check the current surface offset for sequence matches
 *
 * @param {boolean} [isPaste] Whether this in the context of a paste
 */
ve.ce.Surface.prototype.checkSequences = function ( isPaste ) {
	var matchingSequences,
		model = this.getModel(),
		selection = this.getSelection();

	if ( !selection.isNativeCursor() ) {
		return;
	}

	matchingSequences = this.getSurface().sequenceRegistry.findMatching(
		model.getDocument().data,
		selection.getModel().getCoveringRange().end,
		isPaste
	);

	this.executeSequences( matchingSequences );
};

/**
 * Check if any of the previously delayed sequences no longer match with current offset,
 * and therefore should be executed.
 */
ve.ce.Surface.prototype.checkDelayedSequences = function () {
	var matchingSequences, matchingByName, i, matchingSeq,
		sequences = [],
		model = this.getModel(),
		selection = this.getSelection();

	if ( this.deactivated || !selection.isNativeCursor() ) {
		matchingSequences = [];
	} else {
		matchingSequences = this.getSurface().sequenceRegistry.findMatching( model.getDocument().data, selection.getModel().getCoveringRange().end );
	}
	matchingByName = {};
	for ( i = 0; i < matchingSequences.length; i++ ) {
		matchingByName[ matchingSequences[ i ].sequence.getName() ] = matchingSequences[ i ];
	}

	for ( i = 0; i < this.delayedSequences.length; i++ ) {
		matchingSeq = matchingByName[ this.delayedSequences[ i ].sequence.getName() ];
		if (
			!matchingSeq ||
			matchingSeq.range.start !== this.delayedSequences[ i ].range.start
		) {
			// This sequence stopped matching; execute it with the previously saved range
			this.delayedSequences[ i ].wasDelayed = true;
			sequences.push( this.delayedSequences[ i ] );
		}
	}
	// Discard any delayed sequences; they will be checked for again when the user starts typing
	this.delayedSequences = [];

	this.executeSequences( sequences );
};

ve.ce.Surface.prototype.executeSequences = function ( sequences ) {
	var i,
		executed = false;

	// sequences.length will likely be 0 or 1 so don't cache
	for ( i = 0; i < sequences.length; i++ ) {
		if ( sequences[ i ].sequence.delayed && !sequences[ i ].wasDelayed ) {
			// Save the sequence and match range for execution later
			this.delayedSequences.push( sequences[ i ] );
		} else {
			executed = sequences[ i ].sequence.execute( this.surface, sequences[ i ].range ) || executed;
		}
	}
	if ( executed ) {
		this.delayedSequences = [];
		this.showModelSelection();
	}
};

/**
 * See if the just-entered content fits our criteria for setting a history breakpoint
 */
ve.ce.Surface.prototype.maybeSetBreakpoint = function () {
	var offset,
		data = this.getModel().getDocument().data,
		selection = this.getSelection();

	if ( !selection.isNativeCursor() ) {
		return;
	}

	// We have just entered text, probably. We want to know whether we just
	// created a word break. We can't check the current offset, since the
	// common case is that being at the end of the string, which is inherently
	// a word break. So, we check whether the previous offset is a word break,
	// which should catch cases where we have hit space or added punctuation.
	// We use getWordRange because it handles the unicode cases, and accounts
	// for single-character words where a space back is a word break because
	// it's the *start* of a word.

	// Note: Text input which isn't using word breaks, for whatever reason,
	// will get breakpoints set by the fallback timer anyway. This is the
	// main reason to not debounce that timer here, as then a reasonable
	// typist with such text would never get a breakpoint set. The compromise
	// position here will occasionally get a breakpoint set in the middle of
	// the first word typed.

	offset = selection.getModel().getCoveringRange().end - 1;
	if ( data.getWordRange( offset ).end === offset ) {
		this.getModel().breakpoint();
	}
};

/**
 * Handle window resize event.
 *
 * @param {jQuery.Event} e Window resize event
 */
ve.ce.Surface.prototype.onWindowResize = function () {
	this.emit( 'position' );
	if ( OO.ui.isMobile() && !ve.init.platform.constructor.static.isIos() ) {
		// A resize event on mobile is probably a keyboard open/close (or rotate).
		// Either way, ensure the cursor is still visible (T204388).
		// On iOS, window is resized whenever you start scrolling down and the "address bar" is
		// minimized. So don't scroll back up…
		this.getSurface().scrollCursorIntoView();
	}
};

/* Relocation */

/**
 * Start a relocation action.
 */
ve.ce.Surface.prototype.startRelocation = function () {
	// Cache the selection and selectedNode when the drag starts, to
	// avoid having to recompute them while dragging.
	this.relocatingSelection = this.getModel().getSelection();
	this.relocatingNode = this.getModel().getSelectedNode();
	this.emit( 'relocationStart' );
};

/**
 * Complete a relocation action.
 */
ve.ce.Surface.prototype.endRelocation = function () {
	this.relocatingSelection = null;
	this.relocatingNode = null;
	// Trigger a drag leave event to clear markers
	this.onDocumentDragLeave();
	this.emit( 'relocationEnd' );
};

/**
 * Set the active node
 *
 * @param {ve.ce.Node|null} node Active node
 */
ve.ce.Surface.prototype.setActiveNode = function ( node ) {
	this.activeNode = node;
};

/**
 * Get the active node
 *
 * @return {ve.ce.Node|null} Active node
 */
ve.ce.Surface.prototype.getActiveNode = function () {
	return this.activeNode;
};

/* Utilities */

/**
 * Store a state snapshot at a keydown event, to be used in an after-keydown handler
 *
 * A ve.SelectionState object is stored, but only when the key event is a cursor key.
 * (It would be misleading to save selection properties for key events where the DOM might get
 * modified, because anchorNode/focusNode are live and mutable, and so the offsets may come to
 * point confusingly to different places than they did when the selection was saved).
 *
 * @param {jQuery.Event|null} e Key down event; must be active when this call is made
 */
ve.ce.Surface.prototype.storeKeyDownState = function ( e ) {
	this.keyDownState.event = e;
	this.keyDownState.selectionState = null;

	if ( this.nativeSelection.rangeCount > 0 && e && (
		e.keyCode === OO.ui.Keys.UP ||
		e.keyCode === OO.ui.Keys.DOWN ||
		e.keyCode === OO.ui.Keys.LEFT ||
		e.keyCode === OO.ui.Keys.RIGHT
	) ) {
		this.keyDownState.selectionState = new ve.SelectionState( this.nativeSelection );
	}
};

/**
 * Clear a stored state snapshot from a key down event
 */
ve.ce.Surface.prototype.clearKeyDownState = function () {
	this.keyDownState.event = null;
	this.keyDownState.selectionState = null;
};

/**
 * Move the DM surface cursor
 *
 * @param {number} offset Distance to move (negative = toward document start)
 */
ve.ce.Surface.prototype.moveModelCursor = function ( offset ) {
	var selection = this.model.getSelection();
	if ( selection instanceof ve.dm.LinearSelection ) {
		this.model.setLinearSelection( this.model.getDocument().getRelativeRange(
			selection.getRange(),
			offset,
			'character',
			false
		) );
	}
};

/**
 * Get the directionality at the current focused node
 *
 * @return {string} 'ltr' or 'rtl'
 */
ve.ce.Surface.prototype.getFocusedNodeDirectionality = function () {
	var cursorNode,
		range = this.model.getSelection().getRange();

	// Use stored directionality if we have one.
	if ( this.cursorDirectionality ) {
		return this.cursorDirectionality;
	}

	// Else fall back on the CSS directionality of the focused node at the DM selection focus,
	// which is less reliable because it does not take plaintext bidi into account.
	// (range.to will actually be at the edge of the focused node, but the
	// CSS directionality will be the same).
	cursorNode = this.getDocument().getNodeAndOffset( range.to ).node;
	if ( cursorNode.nodeType === Node.TEXT_NODE ) {
		cursorNode = cursorNode.parentNode;
	}
	return $( cursorNode ).css( 'direction' );
};

/**
 * Restore the selection from the model if expands outside the active node
 *
 * This is only useful if the DOM selection and the model selection are out of sync.
 *
 * @return {boolean} Whether the selection was restored
 */
ve.ce.Surface.prototype.restoreActiveNodeSelection = function () {
	var currentRange,
		activeNode = this.getActiveNode(),
		activeRange = activeNode && activeNode.getRange();
	if (
		activeRange &&
		( currentRange = ve.ce.veRangeFromSelection( this.nativeSelection ) ) &&
		( !currentRange.isCollapsed() || activeNode.trapsCursor() ) &&
		!activeRange.containsRange( currentRange )
	) {
		this.showModelSelection();
		return true;
	} else {
		return false;
	}
};

/**
 * Find a ce=false branch node that a native cursor movement from here *might* skip
 *
 * If a node is returned, then it might get skipped by a single native cursor
 * movement in the specified direction from the closest branch node at the
 * current cursor focus. However, if null is returned, then any single such
 * movement is guaranteed *not* to skip an uneditable branch node.
 *
 * Note we cannot predict precisely where/with which cursor key we might step out
 * of the current closest branch node, because it is difficult to predict the
 * behaviour of left/rightarrow (because of bidi visual cursoring) and
 * up/downarrow (because of wrapping).
 *
 * @param {number} direction -1 for before the cursor, +1 for after
 * @return {Node|null} Potentially cursor-adjacent uneditable branch node, or null
 */
ve.ce.Surface.prototype.findAdjacentUneditableBranchNode = function ( direction ) {
	var node, viewNode,
		activeNode = this.getActiveNode(),
		forward = direction > 0;

	node = $( this.nativeSelection.focusNode ).closest(
		'.ve-ce-branchNode,.ve-ce-leafNode,.ve-ce-surface-paste'
	)[ 0 ];
	if ( !node || node.classList.contains( 've-ce-surface-paste' ) ) {
		return null;
	}

	// Walk in document order till we find a ContentBranchNode (in which case
	// return null) or a FocusableNode/TableNode (in which case return the node)
	// or run out of nodes (in which case return null)
	while ( true ) {
		// Step up until we find a sibling
		while ( !( forward ? node.nextSibling : node.previousSibling ) ) {
			node = node.parentNode;
			if ( node === null ) {
				// Reached the document start/end
				return null;
			}
		}
		// Step back
		node = forward ? node.nextSibling : node.previousSibling;
		// Check and step down
		while ( true ) {
			if (
				$.data( node, 'view' ) instanceof ve.ce.ContentBranchNode ||
				// We shouldn't ever hit a raw text node, because they
				// should all be wrapped in CBNs or focusable nodes, but
				// just in case…
				node.nodeType === Node.TEXT_NODE
			) {
				// This is cursorable (must have content or slugs)
				return null;
			}
			if ( $( node ).is( '.ve-ce-focusableNode,.ve-ce-tableNode' ) ) {
				if ( activeNode ) {
					viewNode = $( node ).data( 'view' );
					if ( !activeNode.getRange().containsRange( viewNode.getRange() ) ) {
						// Node is outside the active node
						return null;
					}
				}
				return node;
			}
			if ( !node.childNodes || node.childNodes.length === 0 ) {
				break;
			}
			node = forward ? node.firstChild : node.lastChild;
		}
	}
};

/**
 * Insert cursor holders, if they might be required as a cursor target
 */
ve.ce.Surface.prototype.updateCursorHolders = function () {
	var holderBefore = null,
		holderAfter = null,
		doc = this.getElementDocument(),
		nodeBefore = this.findAdjacentUneditableBranchNode( -1 ),
		nodeAfter = this.findAdjacentUneditableBranchNode( 1 );

	this.removeCursorHolders();

	if ( nodeBefore ) {
		holderBefore = doc.importNode( this.constructor.static.cursorHolderTemplate, true );
		holderBefore.classList.add( 've-ce-cursorHolder-after' );
		if ( ve.inputDebug ) {
			holderBefore.classList.add( 've-ce-cursorHolder-debug' );
		}
		$( nodeBefore ).after( holderBefore );
	}
	if ( nodeAfter ) {
		holderAfter = doc.importNode( this.constructor.static.cursorHolderTemplate, true );
		holderAfter.classList.add( 've-ce-cursorHolder-before' );
		$( nodeAfter ).before( holderAfter );
		if ( ve.inputDebug ) {
			holderAfter.classList.add( 've-ce-cursorHolder-debug' );
		}
	}
	this.cursorHolders = { before: holderBefore, after: holderAfter };
};

/**
 * Remove cursor holders, if they exist
 */
ve.ce.Surface.prototype.removeCursorHolders = function () {
	if ( !this.cursorHolders ) {
		return;
	}
	if ( this.cursorHolders.before && this.cursorHolders.before.parentNode ) {
		this.cursorHolders.before.parentNode.removeChild( this.cursorHolders.before );
	}
	if ( this.cursorHolders.after && this.cursorHolders.after.parentNode ) {
		this.cursorHolders.after.parentNode.removeChild( this.cursorHolders.after );
	}
	this.cursorHolders = null;
};

/**
 * Handle insertion of content.
 */
ve.ce.Surface.prototype.handleInsertion = function () {
	var range,
		surfaceModel = this.getModel(),
		fragment = surfaceModel.getFragment(),
		selection = this.getSelection();

	if ( selection instanceof ve.ce.TableSelection ) {
		// Collapse table selection to anchor cell
		surfaceModel.setSelection( selection.getModel().collapseToFrom() );
		// Delete the current contents
		ve.ce.keyDownHandlerFactory.lookup( 'tableDelete' ).static.execute( this );
		// Place selection inside the cell
		this.documentView.getBranchNodeFromOffset( selection.getModel().tableRange.start + 1 ).setEditing( true );
		// Selection has changed, update
		selection = this.getSelection();
	} else if ( selection.isFocusedNode() ) {
		// Don't allow a user to delete a non-table focusable node just by typing
		return;
	}

	if ( !( selection instanceof ve.ce.LinearSelection ) ) {
		return;
	}

	range = selection.getModel().getRange();

	// Handles removing expanded selection before inserting new text
	if (
		this.selectionSplitsNailedAnnotation() ||
		( !range.isCollapsed() && !this.documentView.rangeInsideOneLeafNode( range ) )
	) {
		// Remove the selection to force its re-application from the DM (even if the
		// DM is too granular to detect the selection change)
		surfaceModel.setNullSelection();
		fragment.removeContent().collapseToStart().select();
		this.surfaceObserver.clear();
		this.storeKeyDownState( this.keyDownState.event );
		this.surfaceObserver.stopTimerLoop();
		this.surfaceObserver.pollOnce();
	}
};

/**
 * Get an approximate range covering data visible in the viewport
 *
 * It is assumed that vertical offset increases as you progress through the DM.
 * Items with custom positioning may throw off results given by this method, so
 * it should only be treated as an approximation.
 *
 * @return {ve.Range} Range covering data visible in the viewport
 */
ve.ce.Surface.prototype.getViewportRange = function () {
	var surface = this,
		documentModel = this.getModel().getDocument(),
		data = documentModel.data,
		dimensions = this.surface.getViewportDimensions(),
		// We want a little padding when finding the range, because this is
		// generally used for things like find/replace, where scrolling to see
		// context is important.
		padding = 50,
		top = Math.max( 0, dimensions.top - padding ),
		bottom = dimensions.bottom + ( padding * 2 ),
		documentRange = this.getModel().getDocument().getDocumentRange();

	function highestIgnoreChildrenNode( childNode ) {
		var ignoreChildrenNode = null;
		childNode.traverseUpstream( function ( node ) {
			if ( node.shouldIgnoreChildren() ) {
				ignoreChildrenNode = node;
			}
		} );
		return ignoreChildrenNode;
	}

	function binarySearch( offset, range, side ) {
		var mid, rect, midNode, ignoreChildrenNode, nodeRange,
			start = range.start,
			end = range.end,
			lastLength = Infinity;

		while ( range.getLength() < lastLength ) {
			lastLength = range.getLength();
			mid = Math.round( ( range.start + range.end ) / 2 );
			midNode = documentModel.documentNode.getNodeFromOffset( mid );
			ignoreChildrenNode = highestIgnoreChildrenNode( midNode );

			if ( ignoreChildrenNode ) {
				nodeRange = ignoreChildrenNode.getOuterRange();
				mid = side === 'top' ? nodeRange.end : nodeRange.start;
			} else {
				mid = data.getNearestContentOffset( mid );
			}

			rect = surface.getSelection( new ve.dm.LinearSelection( new ve.Range( mid ) ) ).getSelectionBoundingRect();
			if ( rect[ side ] > offset ) {
				end = mid;
				range = new ve.Range( range.start, end );
			} else {
				start = mid;
				range = new ve.Range( start, range.end );
			}
		}
		return side === 'bottom' ? start : end;
	}

	return new ve.Range(
		binarySearch( top, documentRange, 'bottom' ),
		binarySearch( bottom, documentRange, 'top' )
	);
};

/**
 * Apply a DM selection to the DOM, even if the old DOM selection is different but DM-equivalent
 *
 * @method
 * @return {boolean} Whether the selection actually changed
 */
ve.ce.Surface.prototype.forceShowModelSelection = function () {
	return this.showModelSelection( true );
};

/**
 * Apply a DM selection to the DOM
 *
 * @method
 * @param {boolean} [force] Replace the DOM selection if it is different but DM-equivalent
 * @return {boolean} Whether the selection actually changed
 */
ve.ce.Surface.prototype.showModelSelection = function ( force ) {
	var selection, changed, modelRange, impliedModelRange;

	if ( this.deactivated ) {
		// setTimeout: Defer until view has updated
		setTimeout( this.updateDeactivatedSelection.bind( this ) );
		return false;
	}

	selection = this.getSelection();
	if ( !selection.isNativeCursor() || this.focusedBlockSlug ) {
		// Model selection is an emulated selection (e.g. table). The view is certain to
		// match it already, because there is no way to change the view selection when
		// an emulated selection is showing.
		return false;
	}
	modelRange = selection.getModel().getRange();
	if ( !force && this.$attachedRootNode.get( 0 ).contains(
		this.nativeSelection.focusNode
	) ) {
		// See whether the model range implied by the DOM selection is already equal to
		// the actual model range. This is necessary because one model selection can
		// correspond to many DOM selections, and we don't want to change a DOM
		// selection that is already valid to an arbitrary different DOM selection.
		impliedModelRange = new ve.Range(
			ve.ce.getOffset(
				this.nativeSelection.anchorNode,
				this.nativeSelection.anchorOffset
			),
			ve.ce.getOffset(
				this.nativeSelection.focusNode,
				this.nativeSelection.focusOffset
			)
		);
		if ( modelRange.equals( impliedModelRange ) ) {
			// Current native selection fits model range; don't change
			return false;
		}
	}
	changed = this.showSelectionState( this.getSelectionState( modelRange ) );
	// Support: Chrome
	// Fixes T131674, which is only triggered with Chromium-style ce=false cursoring
	// restrictions (but other cases of non-updated cursor holders can probably occur
	// in other browsers).
	if ( changed ) {
		this.updateCursorHolders();
		return true;
	}
	return false;
};

/**
 * Apply a selection state to the DOM
 *
 * If the browser cannot show a backward selection, fall back to the forward equivalent
 *
 * @param {ve.SelectionState} selection The selection state to show
 * @return {boolean} Whether the selection actually changed
 */
ve.ce.Surface.prototype.showSelectionState = function ( selection ) {
	var range,
		$focusTarget,
		extendedBackwards = false,
		sel = this.nativeSelection,
		newSel = selection;

	if ( newSel.equalsSelection( sel ) ) {
		this.updateActiveAnnotations();
		return false;
	}

	if ( !newSel.getNativeRange( this.getElementDocument() ) ) {
		// You can still set a linear selection if the document doesn't have any cursorable positions.
		// That's when you end up here.
		sel.removeAllRanges();
		return true;
	}

	if ( newSel.isBackwards ) {
		if ( ve.supportsSelectionExtend ) {
			// Set the range at the anchor, and extend backwards to the focus
			range = this.getElementDocument().createRange();
			range.setStart( newSel.anchorNode, newSel.anchorOffset );
			sel.removeAllRanges();
			sel.addRange( range );
			try {
				sel.extend( newSel.focusNode, newSel.focusOffset );
				extendedBackwards = true;
			} catch ( e ) {
				// Support: Firefox
				// Firefox sometimes fails when nodes are different
				// see https://bugzilla.mozilla.org/show_bug.cgi?id=921444
			}
		}
		if ( !extendedBackwards ) {
			// Fallback: Apply the corresponding forward selection
			newSel = newSel.flip();
			if ( newSel.equalsSelection( sel ) ) {
				this.updateActiveAnnotations();
				return false;
			}
		}
	}

	if ( !extendedBackwards ) {
		// Forward selection
		sel.removeAllRanges();
		sel.addRange( newSel.getNativeRange( this.getElementDocument() ) );
	}

	// Setting a range doesn't give focus in all browsers so make sure this happens
	// Also set focus after range to prevent scrolling to top
	$focusTarget = $( newSel.focusNode ).closest( '[contenteditable=true]' );
	if ( $focusTarget.get( 0 ) === this.getElementDocument().activeElement ) {
		// Already focused, do nothing.
		// Support: IE<=11
		// Focusing already-focused elements scrolls the *top* of the element
		// into view, meaning that in long text blocks refocusing the current
		// element will jump the viewport around.
	} else if ( !OO.ui.contains( $focusTarget.get( 0 ), this.getElementDocument().activeElement ) ) {
		// Note: contains *doesn't* include === here. This is desired, as the
		// common case for getting here is when pressing backspace when the
		// cursor is in the middle of a block of text (thus both are a <div>),
		// and we don't want to scroll away from the caret.
		$focusTarget.trigger( 'focus' );
	} else {
		// Scroll the node into view
		ve.scrollIntoView(
			$( newSel.focusNode ).closest( '*' ).get( 0 )
		);
	}
	this.updateActiveAnnotations();
	return true;
};

/**
 * Update the activeAnnotations property and apply CSS classes accordingly
 *
 * An active annotation is one containing the DOM cursor, which may not be well
 * defined at annotation boundaries, except for links which use nails.
 *
 * Also the order of .activeAnnotations may not be well defined.
 */
ve.ce.Surface.prototype.updateActiveAnnotations = function () {
	var changed = false,
		surface = this,
		activeAnnotations = this.annotationsAtFocus();

	// Iterate over previously active annotations
	this.activeAnnotations.forEach( function ( annotation ) {
		// If not in the new list, turn off
		if ( activeAnnotations.indexOf( annotation ) === -1 ) {
			annotation.$element.removeClass( 've-ce-annotation-active' );
			changed = true;
		}
	} );

	// Iterate over newly active annotations
	activeAnnotations.forEach( function ( annotation ) {
		// If not in the old list, turn on
		if ( surface.activeAnnotations.indexOf( annotation ) === -1 ) {
			annotation.$element.addClass( 've-ce-annotation-active' );
			changed = true;
		}
	} );

	if ( changed ) {
		this.activeAnnotations = activeAnnotations;
		this.model.emit( 'contextChange' );
	}
};

/**
 * Update the selection to contain the contents of a node
 *
 * @param {HTMLElement} node
 * @return {boolean} Whether the selection changed
 */
ve.ce.Surface.prototype.selectNodeContents = function ( node ) {
	var anchor, focus;
	if ( !node ) {
		return false;
	}
	anchor = ve.ce.nextCursorOffset( node.childNodes[ 0 ] );
	focus = ve.ce.previousCursorOffset( node.childNodes[ node.childNodes.length - 1 ] );
	return this.showSelectionState( new ve.SelectionState( {
		anchorNode: anchor.node,
		anchorOffset: anchor.offset, // Past the nail
		focusNode: focus.node,
		focusOffset: focus.offset, // Before the nail
		isCollapsed: false
	} ) );
};

/**
 * Get the annotation views containing the cursor focus
 *
 * @return {ve.ce.Annotation[]} The annotations containing the focus
 */
ve.ce.Surface.prototype.annotationsAtFocus = function () {
	var annotations = [];
	$( this.nativeSelection.focusNode ).parents( '.ve-ce-annotation' ).addBack( '.ve-ce-annotation' ).each( function () {
		var view = $( this ).data( 'view' );
		if ( view && view.canBeActive() ) {
			annotations.push( view );
		}
	} );
	return annotations;
};

/**
 * Get a SelectionState corresponding to a ve.Range.
 *
 * If either endpoint of the ve.Range is not a cursor offset, adjust the SelectionState
 * endpoints to be at cursor offsets. For a collapsed selection, the adjustment preserves
 * collapsedness; for a non-collapsed selection, the adjustment is in the direction that
 * grows the selection (thereby avoiding collapsing or reversing the selection).
 *
 * @method
 * @param {ve.Range} range Range to get selection for
 * @return {ve.SelectionState} The selection
 * @return {Node|null} return.anchorNode The anchor node
 * @return {number} return.anchorOffset The anchor offset
 * @return {Node|null} return.focusNode The focus node
 * @return {number} return.focusOffset The focus offset
 * @return {boolean} return.isCollapsed True if the focus and anchor are in the same place
 * @return {boolean} return.isBackwards True if the focus is before the anchor
 */
ve.ce.Surface.prototype.getSelectionState = function ( range ) {
	var anchor, focus, from, to,
		dmDoc = this.getModel().getDocument();

	// Anchor/focus at the nearest correct position in the direction that
	// grows the selection.
	from = dmDoc.getNearestCursorOffset( range.from, range.isBackwards() ? 1 : -1 );
	if ( from === -1 ) {
		return ve.SelectionState.static.newNullSelection();
	}
	anchor = this.documentView.getNodeAndOffset( from );
	if ( range.isCollapsed() ) {
		focus = anchor;
	} else {
		to = dmDoc.getNearestCursorOffset( range.to, range.isBackwards() ? -1 : 1 );
		if ( to === -1 ) {
			return ve.SelectionState.static.newNullSelection();
		}
		focus = this.documentView.getNodeAndOffset( to );
	}
	return new ve.SelectionState( {
		anchorNode: anchor.node,
		anchorOffset: anchor.offset,
		focusNode: focus.node,
		focusOffset: focus.offset,
		isBackwards: range.isBackwards()
	} );
};

/**
 * Get a native range object for a specified ve.Range
 *
 * Native ranges are only used by linear selections. They don't show whether the selection
 * is backwards, so they should be used for measurement only.
 *
 * @param {ve.Range} [range] Optional range to get the native range for, defaults to current selection's range
 * @return {Range|null} Native range object, or null if there is no suitable selection
 */
ve.ce.Surface.prototype.getNativeRange = function ( range ) {
	var selectionState;

	if ( !range ) {
		// If no range specified, or range is equivalent to current native selection,
		// then use the current native selection
		selectionState = new ve.SelectionState( this.nativeSelection );
	} else {
		selectionState = this.getSelectionState( range );
	}
	return selectionState.getNativeRange( this.getElementDocument() );
};

/**
 * Append passed highlights to highlight container.
 *
 * @method
 * @param {jQuery} $highlights Highlights to append
 * @param {boolean} focused Highlights are currently focused
 */
ve.ce.Surface.prototype.appendHighlights = function ( $highlights, focused ) {
	// Only one item can be blurred-highlighted at a time, so remove the others.
	// Remove by detaching so they don't lose their event handlers, in case they
	// are attached again.
	this.$highlightsBlurred.children().detach();
	if ( focused ) {
		this.$highlightsFocused.append( $highlights );
	} else {
		this.$highlightsBlurred.append( $highlights );
	}
};

/* Getters */

/**
 * Get the top-level surface.
 *
 * @method
 * @return {ve.ui.Surface} Surface
 */
ve.ce.Surface.prototype.getSurface = function () {
	return this.surface;
};

/**
 * Get the surface model.
 *
 * @method
 * @return {ve.dm.Surface} Surface model
 */
ve.ce.Surface.prototype.getModel = function () {
	return this.model;
};

/**
 * Get the document view.
 *
 * @method
 * @return {ve.ce.Document} Document view
 */
ve.ce.Surface.prototype.getDocument = function () {
	return this.documentView;
};

/**
 * Check whether there are any render locks
 *
 * @method
 * @return {boolean} Render is locked
 */
ve.ce.Surface.prototype.isRenderingLocked = function () {
	return this.renderLocks > 0 && !this.readOnly;
};

/**
 * Add a single render lock (to disable rendering)
 *
 * @method
 */
ve.ce.Surface.prototype.incRenderLock = function () {
	this.renderLocks++;
};

/**
 * Remove a single render lock
 *
 * @method
 */
ve.ce.Surface.prototype.decRenderLock = function () {
	this.renderLocks--;
};

/**
 * Escape the current render lock
 *
 * @param {Function} callback Function to run after render lock
 */
ve.ce.Surface.prototype.afterRenderLock = function ( callback ) {
	// TODO: implement an actual tracking system that makes sure renderlock is
	// 0 when this is done.
	// setTimeout: postpone until there is definitely no render lock
	setTimeout( callback );
};

/**
 * Change the model only, not the CE surface
 *
 * This avoids event storms when the CE surface is already correct
 *
 * @method
 * @param {ve.dm.Transaction|ve.dm.Transaction[]|null} transactions One or more transactions to
 * process, or null to process none
 * @param {ve.dm.Selection} selection New selection
 * @throws {Error} If calls to this method are nested
 */
ve.ce.Surface.prototype.changeModel = function ( transactions, selection ) {
	if ( this.newModelSelection !== null ) {
		throw new Error( 'Nested change of newModelSelection' );
	}
	this.newModelSelection = selection;
	try {
		this.model.change( transactions, selection );
	} finally {
		this.newModelSelection = null;
	}
};

/**
 * Inform the surface that one of its ContentBranchNodes' rendering has changed.
 *
 * @see ve.ce.ContentBranchNode#renderContents
 */
ve.ce.Surface.prototype.setContentBranchNodeChanged = function () {
	this.contentBranchNodeChanged = true;
	this.clearKeyDownState();
};

/**
 * Set the node that has the current unicorn.
 *
 * If another node currently has a unicorn, it will be rerendered, which will
 * cause it to release its unicorn.
 *
 * @param {ve.ce.ContentBranchNode} node The node claiming the unicorn
 */
ve.ce.Surface.prototype.setUnicorning = function ( node ) {
	if ( this.setUnicorningRecursionGuard ) {
		throw new Error( 'setUnicorning recursing' );
	}
	if ( this.unicorningNode && this.unicorningNode !== node ) {
		this.setUnicorningRecursionGuard = true;
		try {
			this.unicorningNode.renderContents();
		} finally {
			this.setUnicorningRecursionGuard = false;
		}
	}
	this.unicorningNode = node;
};

/**
 * Release the current unicorn held by a given node.
 *
 * If the node doesn't hold the current unicorn, nothing happens.
 * This function does not cause any node to be rerendered.
 *
 * @param {ve.ce.ContentBranchNode} node The node releasing the unicorn
 */
ve.ce.Surface.prototype.setNotUnicorning = function ( node ) {
	if ( this.unicorningNode === node ) {
		this.unicorningNode = null;
	}
};

/**
 * Ensure that no node has a unicorn.
 *
 * If the given node currently has the unicorn, it will be released and
 * no rerender will happen. If another node has the unicorn, that node
 * will be rerendered to get rid of the unicorn.
 *
 * @param {ve.ce.ContentBranchNode} node The node releasing the unicorn
 */
ve.ce.Surface.prototype.setNotUnicorningAll = function ( node ) {
	if ( this.unicorningNode === node ) {
		// Don't call back node.renderContents()
		this.unicorningNode = null;
	}
	this.setUnicorning( null );
};

/**
 * Get list of selected nodes and annotations.
 *
 * Exclude active annotations unless the CE focus is inside a link
 *
 * @param {boolean} [all] Include nodes and annotations which only cover some of the fragment
 * @return {ve.dm.Model[]} Selected models
 */
ve.ce.Surface.prototype.getSelectedModels = function () {
	var models, fragmentAfter, activeModels;
	if ( !( this.model.selection instanceof ve.dm.LinearSelection ) ) {
		return [];
	}
	models = this.model.getFragment().getSelectedModels();

	if ( this.model.selection.isCollapsed() ) {
		fragmentAfter = this.model.getFragment( new ve.dm.LinearSelection(
			new ve.Range(
				this.model.selection.range.start,
				this.model.selection.range.start + 1
			)
		) );
		models = OO.unique( [].concat(
			models,
			fragmentAfter.getSelectedModels()
		) );
	}

	activeModels = this.activeAnnotations.map( function ( view ) {
		return view.getModel();
	} );

	return models.filter( function ( annModel ) {
		// If the model is an annotation that can be active, only show it if it *is* active
		if ( annModel instanceof ve.dm.Annotation && ve.ce.annotationFactory.canAnnotationBeActive( annModel.getType() ) ) {
			return activeModels.indexOf( annModel ) !== -1;
		}
		return true;
	} );
};

/**
 * Tests whether the selection covers part but not all of a nailed annotation
 *
 * @return {boolean} True if a nailed annotation is split either at the focus or at the anchor (or both)
 */
ve.ce.Surface.prototype.selectionSplitsNailedAnnotation = function () {
	return ve.ce.nailedAnnotationAt( this.nativeSelection.anchorNode ) !==
		ve.ce.nailedAnnotationAt( this.nativeSelection.focusNode );
};

/**
 * Called when the synchronizer receives a remote author selection or name change
 *
 * @param {number} authorId The author ID
 */
ve.ce.Surface.prototype.onSynchronizerAuthorUpdate = function ( authorId ) {
	this.paintAuthor( authorId );
};

/**
 * Called when the synchronizer receives a remote author disconnect
 *
 * @param {number} authorId The author ID
 */
ve.ce.Surface.prototype.onSynchronizerAuthorDisconnect = function ( authorId ) {
	var overlays = this.userSelectionOverlays[ authorId ];

	if ( overlays ) {
		overlays.$cursor.detach();
		overlays.$selection.detach();
		delete this.userSelectionOverlays[ authorId ];
	}
};

/**
 * Called when the synchronizer reconnects and their is a server doc ID mismatch
 */
ve.ce.Surface.prototype.onSynchronizerWrongDoc = function () {
	OO.ui.alert(
		ve.msg( 'visualeditor-missing-document-error' ),
		{ title: ve.msg( 'visualeditor-missing-document-title' ) }
	);
};

/**
 * Paint a remote author's current selection, as stored in the synchronizer
 *
 * @param {number} authorId The author ID
 */
ve.ce.Surface.prototype.paintAuthor = function ( authorId ) {
	var i, l, rects, rect, overlays, color,
		synchronizer = this.model.synchronizer,
		authorData = synchronizer.getAuthorData( authorId ),
		selection = synchronizer.authorSelections[ authorId ];

	if ( !authorData || !selection || authorId === synchronizer.getAuthorId() ) {
		return;
	}

	color = '#' + authorData.color;

	if ( !this.userSelectionOverlays[ authorId ] ) {
		this.userSelectionOverlays[ authorId ] = {
			$cursor: $( '<div>' ),
			$selection: $( '<div>' ),
			deactivateDebounced: ve.debounce( function () {
				// TODO: Transition away the user label when inactive, maybe dim selection
				overlays.$cursor.addClass( 've-ce-surface-highlights-user-cursor-inactive' );
				overlays.$selection.addClass( 've-ce-surface-highlights-user-selection-inactive' );
			}, 5000 )
		};
	}
	overlays = this.userSelectionOverlays[ authorId ];

	if ( !selection || selection.isNull() ) {
		overlays.$cursor.detach();
		overlays.$selection.detach();
		return;
	}

	overlays.$cursor.empty().removeClass( 've-ce-surface-highlights-user-cursor-inactive' );
	overlays.$selection.empty().removeClass( 've-ce-surface-highlights-user-selection-inactive' );

	if ( !selection.isCollapsed() ) {
		rects = ve.ce.Selection.static.newFromModel( selection, this ).getSelectionRects();
		for ( i = 0, l = rects.length; i < l; i++ ) {
			rect = rects[ i ];
			overlays.$selection.append( $( '<div>' ).addClass( 've-ce-surface-highlights-user-selection' ).css( {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
				background: color
			} ) );
		}
	}

	if ( selection instanceof ve.dm.LinearSelection && this.getFocusedNode( selection.getRange() ) ) {
		rect = ve.ce.Selection.static.newFromModel( selection, this ).getSelectionBoundingRect();
	} else {
		rect = ve.ce.Selection.static.newFromModel( selection.collapseToTo(), this ).getSelectionRects()[ 0 ];
	}
	overlays.$cursor.append(
		$( '<div>' ).addClass( 've-ce-surface-highlights-user-cursor' ).css( {
			left: rect.left,
			top: rect.top,
			height: rect.height,
			background: color
		} ).append(
			$( '<span>' )
				.addClass( 've-ce-surface-highlights-user-cursor-label' )
				.text( authorData.name )
				.css( { background: color } )
		)
	);

	this.$highlightsUserCursors.append( overlays.$cursor );
	this.$highlightsUserSelections.append( overlays.$selection );
	overlays.deactivateDebounced();
};

/**
 * Respond to a position event on this surface
 */
ve.ce.Surface.prototype.onPosition = function () {
	var surface = this;

	this.updateDeactivatedSelection();

	if ( this.model.synchronizer ) {
		// Defer to allow surface synchronizer to adjust for transactions
		setTimeout( function () {
			var authorId,
				authorSelections = surface.model.synchronizer.authorSelections;
			for ( authorId in authorSelections ) {
				surface.onSynchronizerAuthorUpdate( +authorId );
			}
		} );
	}
};
