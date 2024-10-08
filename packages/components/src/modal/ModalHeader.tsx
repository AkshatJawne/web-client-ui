import React, {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import classNames from 'classnames';

interface ModalHeaderProps {
  className?: string;
  children?: ReactNode;
  closeButton?: boolean;
  style?: CSSProperties;
  toggle?: () => void;
  'data-testid'?: string;
}

function ModalHeader({
  className,
  children,
  closeButton = true,
  style,
  toggle,
  'data-testid': dataTestId,
}: ModalHeaderProps): ReactElement {
  return (
    <div className={classNames('modal-header', className)} style={style}>
      <h5 className="modal-title">{children}</h5>
      {closeButton && (
        <button
          type="button"
          className="close"
          data-dismiss="modal"
          aria-label="Close"
          onClick={toggle}
        >
          <span aria-hidden="true">&times;</span>
        </button>
      )}
    </div>
  );
}

export default ModalHeader;
