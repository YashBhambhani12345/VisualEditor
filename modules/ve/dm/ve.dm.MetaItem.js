/*!
 * VisualEditor DataModel MetaItem class.
 *
 * @copyright 2011-2013 VisualEditor Team and others; see AUTHORS.txt
 * @license The MIT License (MIT); see LICENSE.txt
 */

/**
 * DataModel meta item.
 *
 * @class
 * @abstract
 * @extends ve.EventEmitter
 * @constructor
 * @param {Object} element Reference to element in meta-linmod
 */
ve.dm.MetaItem = function VeDmMetaItem( element ) {
	// Parent constructor
	ve.EventEmitter.call( this );

	// Properties
	this.element = element;
	this.list = null;
	this.offset = null;
	this.index = null;
};

/* Inheritance */

ve.inheritClass( ve.dm.MetaItem, ve.EventEmitter );

/* Static members */

// TODO these static properties should really be in a base class or mixin, e.g. "matchable"

/**
 * Symbolic name for the meta item class. Must be set to a unique string by every subclass. Must not
 * conflict with names of other nodes, annotations, or meta items.
 * @static
 * @property {string} [static.name=null]
 * @inheritable
 */
ve.dm.MetaItem.static.name = null;

/**
 * Symbolic name for the group this meta item type will be grouped in in ve.dm.MetaList.
 *
 * @static
 * @property {string} [static.group='misc']
 * @inheritable
 */
ve.dm.MetaItem.static.group = 'misc';

/**
 * Array of HTML tag names that this meta item should be a match candidate for.
 * Empty array means none, null means any.
 * For more information about element matching, see ve.dm.ModelRegistry.
 * @static
 * @property {string[]} static.matchTagNames
 * @inheritable
 */
ve.dm.MetaItem.static.matchTagNames = null;

/**
 * Array of RDFa types that this meta item should be a match candidate for.
 * Empty array means none, null means any.
 * For more information about element matching, see ve.dm.ModelRegistry.
 * @static
 * @property {Array} static.matchRdfaType Array of strings or regular expressions
 * @inheritable
 */
ve.dm.MetaItem.static.matchRdfaTypes = null;

/**
 * Optional function to determine whether this meta item should match a given element.
 * Takes an HTMLElement and returns true or false.
 * This function is only called if this meta item has a chance of "winning"; see
 * ve.dm.ModelRegistry for more information about element matching.
 * If set to null, this property is ignored. Setting this to null is not the same as unconditionally
 * returning true, because the presence or absence of a matchFunction affects the node's
 * specificity.
 *
 * NOTE: This function is NOT a method, within this function "this" will not refer to an instance
 * of this class (or to anything reasonable, for that matter).
 * @static
 * @property {Function} static.matchFunction
 * @inheritable
 */
ve.dm.MetaItem.static.matchFunction = null;

/**
 * Static function to convert a DOM element or set of sibling DOM elements to a meta-linmod
 * element for this item type.
 *
 * This function is only called if this item "won" the matching for the first DOM element, so
 * domElements[0] will match this item's matching rule. There is usually only one node in
 * domElements[]. Multiple nodes will only be passed if this item supports about groups.
 * If there are multiple nodes, the nodes are all adjacent siblings in the same about group
 * (i.e. they are grouped together because they have the same value for the about attribute).
 *
 * Meta-elements can occur anywhere, including places where only content is allowed, so meta items
 * generally won't need to worry about the context variables related to content vs. non-content
 * and wrapping as long as they return meta-elements from toDataElement().
 *
 * Note that if this function returns null, the DOM node will be alienated as an alien *node*,
 * not an alien *meta item*.
 *
 * @static
 * @method
 * @param {HTMLElement[]} domElements DOM elements to convert. Usually only one element
 * @param {Object} context Object describing the current state of the converter
 * @param {boolean} context.expectingContent Whether this function is expected to return a content element
 * @param {boolean} context.inWrapper Whether this element is in a wrapper paragraph generated by the converter;
 *  can only be true if context.expectingContent is also true
 * @param {boolean} context.canCloseWrapper Whether the current wrapper paragraph can be closed;
 *  can only be true if context.inWrapper is also true
 * @returns {Object|null} Meta-linmod element, or null to alienate
 */
ve.dm.MetaItem.static.toDataElement = function ( /*domElements, context*/ ) {
	throw new Error( 've.dm.MetaItem subclass must implement toDataElement' );
};

/**
 * Static function to convert a meta-linmod element for this item type back to one or more
 * DOM elements.
 *
 * @static
 * @method
 * @param {Object} Meta-linmod element with a type property and optionally an attributes property
 * @returns {HTMLElement[]} DOM elements
 */
ve.dm.MetaItem.static.toDomElements = function ( /*dataElement*/ ) {
	throw new Error( 've.dm.MetaItem subclass must implement toDomElements' );
};

/**
 * Whether this item supports about grouping. When a DOM element matches an item type that has
 * about grouping enabled, the converter will look for adjacent siblings with the same value for
 * the about attribute, and ask toDataElement() to produce a single data element for all of those
 * DOM nodes combined.
 *
 * @static
 * @property {boolean} static.enableAboutGrouping
 * @inheritable
 */
ve.dm.MetaItem.static.enableAboutGrouping = false;

/**
 * Whether HTML attributes should be preserved for this item type. If true, the HTML attributes
 * of the DOM elements will be stored as attributes in the meta-linmod. The attribute names will be
 * html/i/attrName, where i is the index of the DOM element in the domElements array, and attrName
 * is the name of the attribute.
 *
 * This should generally be enabled, except for item types that store their entire HTML in an
 * attribute.
 *
 * @static
 * @property {boolean} static.storeHtmlAttributes
 * @inheritable
 */
ve.dm.MetaItem.static.storeHtmlAttributes = true;

/* Methods */

/**
 * Get the group this meta item belongs to.
 * @see ve.dm.MetaItem#static.group
 * @returns {string} Group
 */
ve.dm.MetaItem.prototype.getGroup = function () {
	return this.constructor.static.group;
};

/**
 * Get the metadata element this item represents.
 * @returns {Object} Metadata element (by reference)
 */
ve.dm.MetaItem.prototype.getElement = function () {
	return this.element;
};

/**
 * Get the MetaList this item is attached to.
 * @returns {ve.dm.MetaList|null} Reference to the parent list, or null if not attached
 */
ve.dm.MetaItem.prototype.getParentList = function () {
	return this.list;
};

/**
 * Get this item's offset in the linear model.
 *
 * This is only known if the item is attached to a MetaList.
 *
 * @returns {number|null} Offset, or null if not attached
 */
ve.dm.MetaItem.prototype.getOffset = function () {
	return this.offset;
};

/**
 * Get this item's index in the metadata array at the offset.
 *
 * This is only known if the item is attached to a MetaList.
 *
 * @returns {number|null} Index, or null if not attached
 */
ve.dm.MetaItem.prototype.getIndex = function () {
	return this.index;
};

/**
 * Set the offset. This is used by the parent list to synchronize the item with the document state.
 * @param {number} offset New offset
 */
ve.dm.MetaItem.prototype.setOffset = function ( offset ) {
	this.offset = offset;
};

/**
 * Set the index. This is used by the parent list to synchronize the item with the document state.
 * @param {number} index New index
 */
ve.dm.MetaItem.prototype.setIndex = function ( index ) {
	this.index = index;
};

/**
 * Attach this item to a MetaList.
 * @param {ve.dm.MetaList} list Parent list to attach to
 * @param {number} offset Offset of this item in the parent list's document
 * @param {number} index Index of this item in the metadata array at the offset
 */
ve.dm.MetaItem.prototype.attach = function ( list, offset, index ) {
	this.list = list;
	this.offset = offset;
	this.index = index;
};

/**
 * Detach this item from its parent list.
 *
 * This clears the stored offset and index, unless the item has already been attached to another list.
 *
 * @param {ve.dm.MetaList} list List to detach from
 */
ve.dm.MetaItem.prototype.detach = function ( list ) {
	if ( this.list === list ) {
		this.list = null;
		this.offset = null;
		this.index = null;
	}
};
