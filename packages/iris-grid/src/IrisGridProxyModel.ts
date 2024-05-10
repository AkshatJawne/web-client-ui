/* eslint class-methods-use-this: "off" */
import deepEqual from 'fast-deep-equal';
import { Formatter, TableUtils } from '@deephaven/jsapi-utils';
import Log from '@deephaven/log';
import {
  CancelablePromise,
  EventShimCustomEvent,
  PromiseUtils,
} from '@deephaven/utils';
import type { dh as DhType } from '@deephaven/jsapi-types';
import {
  EditableGridModel,
  DeletableGridModel,
  GridRange,
  isEditableGridModel,
  isExpandableGridModel,
  ModelIndex,
  MoveOperation,
  isDeletableGridModel,
} from '@deephaven/grid';
import IrisGridTableModel from './IrisGridTableModel';
import IrisGridPartitionedTableModel from './IrisGridPartitionedTableModel';
import IrisGridTreeTableModel from './IrisGridTreeTableModel';
import IrisGridModel from './IrisGridModel';
import {
  ColumnName,
  UITotalsTableConfig,
  PendingDataMap,
  UIRow,
  PendingDataErrorMap,
} from './CommonTypes';
import { isIrisGridTableModelTemplate } from './IrisGridTableModelTemplate';
import type ColumnHeaderGroup from './ColumnHeaderGroup';
import {
  PartitionConfig,
  PartitionedGridModel,
  isPartitionedGridModelProvider,
} from './PartitionedGridModel';

const log = Log.module('IrisGridProxyModel');

function makeModel(
  dh: typeof DhType,
  table: DhType.Table | DhType.TreeTable | DhType.PartitionedTable,
  formatter?: Formatter,
  inputTable?: DhType.InputTable | null
): IrisGridModel {
  if (TableUtils.isTreeTable(table)) {
    return new IrisGridTreeTableModel(dh, table, formatter);
  }
  if (TableUtils.isPartitionedTable(table)) {
    return new IrisGridPartitionedTableModel(dh, table, formatter);
  }
  return new IrisGridTableModel(dh, table, formatter, inputTable);
}

/**
 * Model which proxies calls to other IrisGridModels.
 * This allows for operations that generate new tables, like rollups.
 */
class IrisGridProxyModel extends IrisGridModel implements PartitionedGridModel {
  /**
   * @param dh JSAPI instance
   * @param table Iris data table to be used in the model
   * @param formatter The formatter to use when getting formats
   * @param inputTable Iris input table associated with this table
   */

  dh: typeof DhType;

  originalModel: IrisGridModel;

  model: IrisGridModel;

  modelPromise: CancelablePromise<IrisGridModel> | null;

  rollup: DhType.RollupConfig | null;

  partition: PartitionConfig | null;

  selectDistinct: ColumnName[];

  currentViewport?: {
    top: number;
    bottom: number;
    columns?: DhType.Column[];
  };

  constructor(
    dh: typeof DhType,
    table: DhType.Table | DhType.TreeTable | DhType.PartitionedTable,
    formatter = new Formatter(dh),
    inputTable: DhType.InputTable | null = null
  ) {
    super(dh);

    this.handleModelEvent = this.handleModelEvent.bind(this);

    const model = makeModel(dh, table, formatter, inputTable);
    this.dh = dh;
    this.originalModel = model;
    this.model = model;
    this.modelPromise = null;
    this.rollup = null;
    this.partition = null;
    this.selectDistinct = [];
  }

  close(): void {
    this.originalModel.close();
    if (this.model !== this.originalModel) {
      this.model.close();
    }
    if (this.modelPromise != null) {
      this.modelPromise.cancel();
    }
  }

  handleModelEvent(event: CustomEvent): void {
    log.debug2('handleModelEvent', event);

    const { detail, type } = event;
    this.dispatchEvent(new EventShimCustomEvent(type, { detail }));
  }

  setModel(model: IrisGridModel): void {
    log.debug('setModel', model);

    const oldModel = this.model;
    const { columns: oldColumns } = oldModel;

    if (oldModel !== this.originalModel) {
      oldModel.close();
    }

    this.model = model;

    if (this.listenerCount > 0) {
      this.addListeners(model);
    }

    if (oldColumns !== model.columns) {
      this.dispatchEvent(
        new EventShimCustomEvent(IrisGridModel.EVENT.COLUMNS_CHANGED, {
          detail: model.columns,
        })
      );
    } else if (this.currentViewport != null) {
      // If the columns haven't changed, the current viewport should still valid, and needs to be set on the new model
      const { top, bottom, columns } = this.currentViewport;
      model.setViewport(top, bottom, columns);
    }

    if (isIrisGridTableModelTemplate(model)) {
      this.dispatchEvent(
        new EventShimCustomEvent(IrisGridModel.EVENT.TABLE_CHANGED, {
          detail: model.table,
        })
      );
    }
  }

  setNextModel(modelPromise: Promise<IrisGridModel>): void {
    log.debug2('setNextModel');

    if (this.modelPromise) {
      this.modelPromise.cancel();
    }

    if (this.listenerCount > 0) {
      this.removeListeners(this.model);
    }

    this.modelPromise = PromiseUtils.makeCancelable(
      modelPromise,
      (model: IrisGridModel) => model.close()
    );
    this.modelPromise
      .then(model => {
        this.modelPromise = null;
        this.setModel(model);
      })
      .catch((err: unknown) => {
        if (PromiseUtils.isCanceled(err)) {
          log.debug2('setNextModel cancelled');
          return;
        }

        log.error('Unable to set next model', err);
        this.modelPromise = null;

        this.dispatchEvent(
          new EventShimCustomEvent(IrisGridModel.EVENT.REQUEST_FAILED, {
            detail: err,
          })
        );
      });
  }

  startListening(): void {
    super.startListening();

    this.addListeners(this.model);
  }

  stopListening(): void {
    super.stopListening();

    this.removeListeners(this.model);
  }

  addListeners(model: IrisGridModel): void {
    const events = Object.keys(IrisGridModel.EVENT);
    for (let i = 0; i < events.length; i += 1) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      model.addEventListener(events[i], this.handleModelEvent);
    }
  }

  removeListeners(model: IrisGridModel): void {
    const events = Object.keys(IrisGridModel.EVENT);
    for (let i = 0; i < events.length; i += 1) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      model.removeEventListener(events[i], this.handleModelEvent);
    }
  }

  get rowCount(): number {
    return this.model.rowCount;
  }

  get columnCount(): number {
    return this.model.columnCount;
  }

  get floatingTopRowCount(): number {
    return this.model.floatingTopRowCount;
  }

  get floatingBottomRowCount(): number {
    return this.model.floatingBottomRowCount;
  }

  get floatingLeftColumnCount(): number {
    return this.model.floatingLeftColumnCount;
  }

  get floatingRightColumnCount(): number {
    return this.model.floatingRightColumnCount;
  }

  textForCell: IrisGridModel['textForCell'] = (...args) =>
    this.model.textForCell(...args);

  truncationCharForCell: IrisGridModel['truncationCharForCell'] = (...args) =>
    this.model.truncationCharForCell(...args);

  textAlignForCell: IrisGridModel['textAlignForCell'] = (...args) =>
    this.model.textAlignForCell(...args);

  colorForCell: IrisGridModel['colorForCell'] = (...args) =>
    this.model.colorForCell(...args);

  backgroundColorForCell: IrisGridModel['backgroundColorForCell'] = (...args) =>
    this.model.backgroundColorForCell(...args);

  textForColumnHeader: IrisGridModel['textForColumnHeader'] = (...args) =>
    this.model.textForColumnHeader(...args);

  colorForColumnHeader: IrisGridModel['colorForColumnHeader'] = (...args) =>
    this.model.colorForColumnHeader(...args);

  textForRowHeader: IrisGridModel['textForRowHeader'] = (...args) =>
    this.model.textForRowHeader(...args);

  textForRowFooter: IrisGridModel['textForRowFooter'] = (...args) =>
    this.model.textForRowFooter(...args);

  isRowMovable: IrisGridModel['isRowMovable'] = (...args) =>
    this.model.isRowMovable(...args);

  isColumnMovable: IrisGridModel['isColumnMovable'] = (...args) =>
    this.model.isColumnMovable(...args);

  isColumnFrozen(x: ModelIndex): boolean {
    return this.model.isColumnFrozen(x);
  }

  isColumnSortable(index: number): boolean {
    return this.model.isColumnSortable(index);
  }

  get hasExpandableRows(): boolean {
    if (isExpandableGridModel(this.model)) {
      return this.model.hasExpandableRows;
    }
    return false;
  }

  get isExpandAllAvailable(): boolean {
    if (isExpandableGridModel(this.model)) {
      return this.model.isExpandAllAvailable ?? false;
    }
    return false;
  }

  isRowExpandable: IrisGridTreeTableModel['isRowExpandable'] = (...args) => {
    if (isExpandableGridModel(this.model)) {
      return this.model.isRowExpandable(...args);
    }
    return false;
  };

  isRowExpanded: IrisGridTreeTableModel['isRowExpanded'] = (...args) => {
    if (isExpandableGridModel(this.model)) {
      return this.model.isRowExpanded(...args);
    }
    return false;
  };

  setRowExpanded: IrisGridTreeTableModel['setRowExpanded'] = (...args) => {
    if (isExpandableGridModel(this.model)) {
      return this.model.setRowExpanded(...args);
    }
    throw Error('Function setRowExpanded does not exist on IrisGridTableModel');
  };

  expandAll: IrisGridTreeTableModel['expandAll'] = () => {
    if (isExpandableGridModel(this.model)) {
      return this.model.expandAll();
    }
    throw Error('Function expandAll does not exist on IrisGridTableModel');
  };

  collapseAll: IrisGridTreeTableModel['collapseAll'] = () => {
    if (isExpandableGridModel(this.model)) {
      return this.model.collapseAll();
    }
    throw Error('Function collapseAll does not exist on IrisGridTableModel');
  };

  depthForRow: IrisGridTreeTableModel['depthForRow'] = (...args) => {
    if (isExpandableGridModel(this.model)) {
      return this.model.depthForRow(...args);
    }
    return 0;
    // throw Error('Function depthForRow does not exist on IrisGridTableModel');
  };

  get isExportAvailable(): boolean {
    return this.model.isExportAvailable;
  }

  get isColumnStatisticsAvailable(): boolean {
    return this.model.isColumnStatisticsAvailable;
  }

  get isValuesTableAvailable(): boolean {
    return this.model.isValuesTableAvailable;
  }

  get isCustomColumnsAvailable(): boolean {
    return (
      this.model.isCustomColumnsAvailable &&
      // Disable for selectDistinct tables
      !(this.isSelectDistinctAvailable && this.selectDistinctColumns.length > 0)
    );
  }

  get isFormatColumnsAvailable(): boolean {
    return this.model.isFormatColumnsAvailable;
  }

  get isChartBuilderAvailable(): boolean {
    return this.model.isChartBuilderAvailable;
  }

  get isRollupAvailable(): boolean {
    return (
      (this.originalModel.isRollupAvailable || this.rollup != null) &&
      this.selectDistinct.length === 0
    );
  }

  get isSelectDistinctAvailable(): boolean {
    return (
      (this.originalModel.isSelectDistinctAvailable ||
        this.selectDistinct.length > 0) &&
      this.rollup == null
    );
  }

  get isTotalsAvailable(): boolean {
    return this.model.isTotalsAvailable;
  }

  get isReversible(): boolean {
    return this.model.isReversible;
  }

  get columns(): readonly DhType.Column[] {
    return this.model.columns;
  }

  get initialMovedColumns(): readonly MoveOperation[] {
    return this.model.initialMovedColumns;
  }

  get initialMovedRows(): readonly MoveOperation[] {
    return this.model.initialMovedRows;
  }

  get layoutHints(): DhType.LayoutHints | null | undefined {
    return this.model.layoutHints;
  }

  get frontColumns(): readonly ColumnName[] {
    return this.model.frontColumns;
  }

  get backColumns(): readonly ColumnName[] {
    return this.model.backColumns;
  }

  get frozenColumns(): readonly ColumnName[] {
    return this.model.frozenColumns;
  }

  getColumnHeaderGroup: IrisGridModel['getColumnHeaderGroup'] = (...args) =>
    this.model.getColumnHeaderGroup(...args);

  get columnHeaderGroups(): readonly ColumnHeaderGroup[] {
    return this.model.columnHeaderGroups;
  }

  set columnHeaderGroups(groups: readonly ColumnHeaderGroup[]) {
    this.model.columnHeaderGroups = groups;
  }

  get initialColumnHeaderGroups(): readonly ColumnHeaderGroup[] {
    return this.model.initialColumnHeaderGroups;
  }

  getColumnHeaderParentGroup: IrisGridModel['getColumnHeaderParentGroup'] = (
    ...args
  ) => this.model.getColumnHeaderParentGroup(...args);

  get columnHeaderGroupMap(): ReadonlyMap<string, ColumnHeaderGroup> {
    return this.model.columnHeaderGroupMap;
  }

  get columnHeaderMaxDepth(): number {
    return this.model.columnHeaderMaxDepth;
  }

  updateFrozenColumns(columns: readonly ColumnName[]): void {
    return this.model.updateFrozenColumns(columns);
  }

  get originalColumns(): readonly DhType.Column[] {
    return this.originalModel.columns;
  }

  get groupedColumns(): readonly DhType.Column[] {
    return this.model.groupedColumns;
  }

  get partitionColumns(): readonly DhType.Column[] {
    if (!isPartitionedGridModelProvider(this.originalModel)) {
      return [];
    }
    return this.originalModel.partitionColumns;
  }

  sourceForCell: IrisGridModel['sourceForCell'] = (...args) =>
    this.model.sourceForCell(...args);

  getClearFilterRange: IrisGridModel['getClearFilterRange'] = (...args) =>
    this.model.getClearFilterRange(...args);

  get description(): string {
    return this.model.description;
  }

  formatForCell: IrisGridModel['formatForCell'] = (...args) =>
    this.model.formatForCell(...args);

  valueForCell: IrisGridModel['valueForCell'] = (...args) =>
    this.model.valueForCell(...args);

  renderTypeForCell: IrisGridModel['renderTypeForCell'] = (...args) =>
    this.model.renderTypeForCell(...args);

  dataBarOptionsForCell: IrisGridModel['dataBarOptionsForCell'] = (...args) =>
    this.model.dataBarOptionsForCell(...args);

  get filter(): readonly DhType.FilterCondition[] {
    return this.model.filter;
  }

  set filter(filter: readonly DhType.FilterCondition[]) {
    this.model.filter = filter;
  }

  get partitionConfig(): PartitionConfig | null {
    if (
      !isPartitionedGridModelProvider(this.originalModel) ||
      !this.originalModel.isPartitionRequired
    ) {
      return null;
    }
    return this.partition;
  }

  set partitionConfig(partitionConfig: PartitionConfig | null) {
    if (!this.isPartitionRequired) {
      throw new Error('Partitions are not available');
    }
    log.debug('set partitionConfig', partitionConfig);
    this.partition = partitionConfig;

    let modelPromise = Promise.resolve(this.originalModel);
    if (
      partitionConfig != null &&
      isPartitionedGridModelProvider(this.originalModel)
    ) {
      if (partitionConfig.mode === 'keys') {
        modelPromise = this.originalModel
          .partitionKeysTable()
          .then(table => makeModel(this.dh, table, this.formatter));
      } else if (partitionConfig.mode === 'merged') {
        modelPromise = this.originalModel
          .partitionMergedTable()
          .then(table => makeModel(this.dh, table, this.formatter));
      } else {
        modelPromise = this.originalModel
          .partitionTable(partitionConfig.partitions)
          .then(table => makeModel(this.dh, table, this.formatter));
      }
    }

    this.setNextModel(modelPromise);
  }

  partitionKeysTable(): Promise<DhType.Table> {
    if (!isPartitionedGridModelProvider(this.originalModel)) {
      throw new Error('Partitions are not available');
    }
    return this.originalModel.partitionKeysTable();
  }

  partitionMergedTable(): Promise<DhType.Table> {
    if (!isPartitionedGridModelProvider(this.originalModel)) {
      throw new Error('Partitions are not available');
    }
    return this.originalModel.partitionMergedTable();
  }

  partitionTable(partitions: unknown[]): Promise<DhType.Table> {
    if (!isPartitionedGridModelProvider(this.originalModel)) {
      throw new Error('Partitions are not available');
    }
    return this.originalModel.partitionTable(partitions);
  }

  get formatter(): Formatter {
    return this.model.formatter;
  }

  set formatter(formatter: Formatter) {
    this.model.formatter = formatter;
  }

  displayString: IrisGridModel['displayString'] = (...args) =>
    this.model.displayString(...args);

  get sort(): readonly DhType.Sort[] {
    return this.model.sort;
  }

  set sort(sort: readonly DhType.Sort[]) {
    this.model.sort = sort;
  }

  get customColumns(): readonly ColumnName[] {
    return this.model.customColumns;
  }

  set customColumns(customColumns: readonly ColumnName[]) {
    this.model.customColumns = customColumns;
  }

  get formatColumns(): readonly DhType.CustomColumn[] {
    return this.model.formatColumns;
  }

  set formatColumns(formatColumns: readonly DhType.CustomColumn[]) {
    this.model.formatColumns = formatColumns;
  }

  get rollupConfig(): DhType.RollupConfig | null {
    return this.rollup;
  }

  set rollupConfig(rollupConfig: DhType.RollupConfig | null) {
    log.debug('set rollupConfig', rollupConfig);

    if (!this.isRollupAvailable) {
      throw new Error('Rollup Rows are not available');
    }

    // Prevent model update when IrisGridModelUpdater is mounted
    // if rollup is already initialized in IrisGridPanel
    if (deepEqual(rollupConfig, this.rollup)) {
      return;
    }

    this.rollup = rollupConfig;

    let modelPromise = Promise.resolve(this.originalModel);

    if (
      isIrisGridTableModelTemplate(this.originalModel) &&
      rollupConfig != null
    ) {
      modelPromise = this.originalModel.table
        .rollup(rollupConfig)
        .then(table => makeModel(this.dh, table, this.formatter));
    }
    this.setNextModel(modelPromise);
  }

  get selectDistinctColumns(): ColumnName[] {
    return this.selectDistinct;
  }

  set selectDistinctColumns(columnNames: string[]) {
    log.debug('set selectDistinctColumns', columnNames);

    if (!this.isSelectDistinctAvailable) {
      throw new Error('Select distinct is not available');
    }

    if (
      columnNames === this.selectDistinctColumns ||
      (columnNames.length === 0 && this.selectDistinctColumns.length === 0)
    ) {
      log.debug('Ignore same selectDistinctColumns', columnNames);
      return;
    }

    this.selectDistinct = columnNames;

    const selectDistinctColumns = columnNames
      .map(name => this.originalColumns.find(column => column.name === name))
      .filter(column => column != null) as DhType.Column[];

    let modelPromise = Promise.resolve(this.originalModel);

    if (
      isIrisGridTableModelTemplate(this.originalModel) &&
      selectDistinctColumns.length > 0
    ) {
      modelPromise = this.originalModel.table
        .selectDistinct(selectDistinctColumns)
        .then(table => makeModel(this.dh, table, this.formatter));
    }
    this.setNextModel(modelPromise);
  }

  get table(): DhType.Table | DhType.TreeTable | undefined {
    if (isIrisGridTableModelTemplate(this.model)) {
      return this.model.table;
    }

    return undefined;
  }

  get totalsConfig(): UITotalsTableConfig | null {
    return this.model.totalsConfig;
  }

  set totalsConfig(totalsConfig: UITotalsTableConfig | null) {
    this.model.totalsConfig = totalsConfig;
  }

  get isFilterRequired(): boolean {
    return this.originalModel.isFilterRequired;
  }

  get isPartitionRequired(): boolean {
    return isPartitionedGridModelProvider(this.originalModel)
      ? this.originalModel.isPartitionRequired
      : false;
  }

  get isEditable(): boolean {
    return isEditableGridModel(this.model) && this.model.isEditable;
  }

  get isDeletable(): boolean {
    return isDeletableGridModel(this.model) && this.model.isDeletable;
  }

  get isViewportPending(): boolean {
    return this.model.isViewportPending;
  }

  isEditableRange: IrisGridTableModel['isEditableRange'] = (
    ...args
  ): boolean => {
    if (isEditableGridModel(this.model)) {
      return this.model.isEditableRange(...args);
    }
    return false;
  };

  isDeletableRange: IrisGridTableModel['isDeletableRange'] = (
    ...args
  ): boolean => {
    if (isDeletableGridModel(this.model)) {
      return this.model.isDeletableRange(...args);
    }
    return false;
  };

  isDeletableRanges: IrisGridModel['isDeletableRanges'] = (
    ...args
  ): boolean => {
    if (isDeletableGridModel(this.model)) {
      return this.model.isDeletableRanges(...args);
    }
    return false;
  };

  isFilterable: IrisGridTableModel['isFilterable'] = (...args) =>
    this.model.isFilterable(...args);

  setViewport = (
    top: number,
    bottom: number,
    columns?: DhType.Column[]
  ): void => {
    this.currentViewport = { top, bottom, columns };
    this.model.setViewport(top, bottom, columns);
  };

  snapshot: IrisGridModel['snapshot'] = (...args) =>
    this.model.snapshot(...args);

  textSnapshot: IrisGridTableModel['textSnapshot'] = (...args) =>
    this.model.textSnapshot(...args);

  export(): Promise<DhType.Table> {
    if (TableUtils.isTreeTable(this.model)) {
      throw new Error("TreeTable has no 'export' property");
    }
    return (this.model as IrisGridTableModel).export();
  }

  valuesTable: IrisGridTableModel['valuesTable'] = (...args) =>
    this.model.valuesTable(...args);

  columnStatistics(column: DhType.Column): Promise<DhType.ColumnStatistics> {
    if (TableUtils.isTreeTable(this.model)) {
      throw new Error("TreeTable has no 'columnStatistics' function");
    }
    return (this.model as IrisGridTableModel).columnStatistics(column);
  }

  editValueForCell: IrisGridTableModel['editValueForCell'] = (...args) => {
    if (isEditableGridModel(this.model)) {
      return this.model.editValueForCell(...args);
    }
    return '';
  };

  setValueForCell: IrisGridTableModel['setValueForCell'] = (...args) => {
    if (isEditableGridModel(this.model)) {
      return this.model.setValueForCell(...args);
    }
    return Promise.reject(new Error('Model is not editable'));
  };

  setValueForRanges: IrisGridTableModel['setValueForRanges'] = (...args) => {
    if (isEditableGridModel(this.model)) {
      return this.model.setValueForRanges(...args);
    }
    return Promise.reject(new Error('Model is not editable'));
  };

  setValues: EditableGridModel['setValues'] = (...args) => {
    if (isEditableGridModel(this.model)) {
      return this.model.setValues(...args);
    }
    return Promise.resolve();
  };

  isValidForCell: IrisGridTableModel['isValidForCell'] = (...args) => {
    if (isEditableGridModel(this.model)) {
      return this.model.isValidForCell(...args);
    }
    return false;
  };

  delete: IrisGridTableModel['delete'] = (...args) =>
    this.model.delete(...args);

  get pendingDataMap(): PendingDataMap<UIRow> {
    return this.model.pendingDataMap;
  }

  set pendingDataMap(map: PendingDataMap<UIRow>) {
    this.model.pendingDataMap = map;
  }

  get pendingRowCount(): number {
    return this.model.pendingRowCount;
  }

  set pendingRowCount(count: number) {
    this.model.pendingRowCount = count;
  }

  get pendingDataErrors(): PendingDataErrorMap {
    return this.model.pendingDataErrors;
  }

  commitPending: IrisGridTableModel['commitPending'] = (...args) =>
    this.model.commitPending(...args);

  getColumnIndexByName(name: ColumnName): number | undefined {
    return this.model.getColumnIndexByName(name);
  }

  async seekRow(
    startRow: number,
    column: DhType.Column,
    valueType: DhType.ValueTypeType,
    value: unknown,
    insensitive?: boolean,
    contains?: boolean,
    isBackwards?: boolean
  ): Promise<number> {
    return this.model.seekRow(
      startRow,
      column,
      valueType,
      value,
      insensitive,
      contains,
      isBackwards
    );
  }

  get isSeekRowAvailable(): boolean {
    return this.model.isSeekRowAvailable;
  }
}

export default IrisGridProxyModel;
